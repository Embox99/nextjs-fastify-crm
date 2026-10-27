import {
  MAX_AUTOMATION_DEPTH, runJobId, type DomainEvent, type ExecuteRunJob, type TriggerType,
} from '@crm/contracts';
import { automationRuns, automations, deals, systemContext, withRls } from '@crm/db';
import { evaluate, triggerMatches } from '@crm/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';
import { dealFacts, parseAutomation } from './load';
import { scheduleSlaCheck } from './sla';

/** Какие типы триггеров вообще могут сработать на событие — чтобы не читать все автоматизации */
const TRIGGERS_FOR: Partial<Record<DomainEvent['type'], TriggerType[]>> = {
  'lead.created': ['LeadCreated'],
  'deal.stage_changed': ['StageChanged'],
  'deal.sla_breached': ['StageSlaBreached'],
};

export const depthOf = (event: DomainEvent) => (event.actor.kind === 'automation' ? event.actor.depth : 0);

/**
 * Доменное событие → запуски автоматизаций. Условия вычисляются по актуальному состоянию сделки
 * (событие могло пролежать в очереди). Запуск фиксируется строкой automation_runs с unique
 * (automation_id, event_key): повторная доставка события ничего не запустит второй раз.
 */
export async function handleDomainEvent(deps: WorkerDeps, event: DomainEvent): Promise<string[]> {
  const depth = depthOf(event);
  if (depth >= MAX_AUTOMATION_DEPTH) {
    deps.log.warn({ eventId: event.id, depth }, 'automation chain depth exceeded — event ignored');
    return [];
  }

  if (event.type === 'deal.stage_changed' || event.type === 'lead.created' || event.type === 'deal.created') {
    await scheduleSlaCheck(deps, event);
  }

  const triggerTypes = TRIGGERS_FOR[event.type];
  if (!triggerTypes || !event.dealId) return [];

  const ctx = systemContext(event.organizationId, event.workspaceId);
  const runIds = await withRls(deps.db, ctx, async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, event.dealId!));
    if (!deal) return [];

    const rows = await tx.select().from(automations).where(and(
      eq(automations.workspaceId, event.workspaceId),
      eq(automations.enabled, true),
      inArray(automations.triggerType, triggerTypes),
    ));

    const created: string[] = [];
    for (const row of rows) {
      const automation = parseAutomation(row);
      if (!automation) {
        deps.log.warn({ automationId: row.id }, 'automation has invalid definition — skipped');
        continue;
      }
      if (!triggerMatches(automation.trigger, event) || !evaluate(automation.conditions, dealFacts(deal))) continue;

      const [run] = await tx.insert(automationRuns).values({
        organizationId: event.organizationId,
        workspaceId: event.workspaceId,
        automationId: automation.id,
        automationVersion: automation.version,
        eventKey: `evt-${event.id}`,
        dealId: deal.id,
        depth,
      }).onConflictDoNothing().returning({ id: automationRuns.id });
      if (run) created.push(run.id);
    }
    return created;
  });

  await enqueueRuns(deps, event.organizationId, event.workspaceId, runIds);
  return runIds;
}

export async function enqueueRuns(deps: WorkerDeps, organizationId: string, workspaceId: string, runIds: string[]) {
  if (runIds.length === 0) return;
  await deps.queues.automations.addBulk(runIds.map((runId) => ({
    name: 'execute-run',
    data: { runId, organizationId, workspaceId } satisfies ExecuteRunJob,
    opts: { jobId: runJobId(runId), attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
  })));
}
