import { automationRuns, automations, deals, systemContext, withRls } from '@crm/db';
import { evaluate } from '@crm/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';
import { dealFacts, parseAutomation } from './load';
import { enqueueRuns } from './matcher';

const DEALS_PER_AUTOMATION = 500;

/**
 * «Нет активности N дней» — не отложенные задачи. Таймер на каждую сделку, переносимый при каждой
 * активности, — это миллионы задач и постоянные перепланирования. Вместо этого периодический проход
 * по частичному индексу deals_stale_idx. event_key с датой: одна сделка запускает автоматизацию
 * не чаще раза в сутки, пока остаётся без активности.
 */
export async function scanStaleDeals(deps: WorkerDeps, now = new Date()): Promise<number> {
  const targets = await deps.db.execute<{ id: string; organization_id: string; workspace_id: string }>(
    sql`select * from app.enabled_automations_by_trigger('NoActivityInDays')`,
  );
  const day = now.toISOString().slice(0, 10);
  let total = 0;

  for (const t of targets) {
    const runIds = await withRls(deps.db, systemContext(t.organization_id, t.workspace_id), async (tx) => {
      const [row] = await tx.select().from(automations).where(eq(automations.id, t.id));
      const automation = row && parseAutomation(row);
      if (!automation || automation.trigger.type !== 'NoActivityInDays') return [];

      const threshold = new Date(now.getTime() - automation.trigger.days * 86_400_000);
      const stale = await tx.select().from(deals).where(and(
        eq(deals.workspaceId, t.workspace_id),
        isNull(deals.closedAt),
        sql`coalesce(${deals.lastActivityAt}, ${deals.createdAt}) < ${threshold.toISOString()}::timestamptz`,
      )).limit(DEALS_PER_AUTOMATION);

      const created: string[] = [];
      for (const deal of stale) {
        if (!evaluate(automation.conditions, dealFacts(deal))) continue;
        const [run] = await tx.insert(automationRuns).values({
          organizationId: t.organization_id,
          workspaceId: t.workspace_id,
          automationId: automation.id,
          automationVersion: automation.version,
          eventKey: `stale-${deal.id}-${day}`,
          dealId: deal.id,
        }).onConflictDoNothing().returning({ id: automationRuns.id });
        if (run) created.push(run.id);
      }
      return created;
    });

    await enqueueRuns(deps, t.organization_id, t.workspace_id, runIds);
    total += runIds.length;
  }
  return total;
}
