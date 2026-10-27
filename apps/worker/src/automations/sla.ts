import { slaJobId, type DomainEvent, type SlaCheckJob } from '@crm/contracts';
import { appendOutbox, deals, pipelineStages, systemContext, withRls } from '@crm/db';
import { eq } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';

/**
 * Сделка вошла в этап с SLA — отложенная проверка через sla_minutes.
 * jobId включает момент входа в этап: уход и возврат в тот же этап — новая проверка, а не дубль.
 */
export async function scheduleSlaCheck(deps: WorkerDeps, event: DomainEvent): Promise<void> {
  if (!event.dealId) return;
  const ctx = systemContext(event.organizationId, event.workspaceId);
  const target = await withRls(deps.db, ctx, async (tx) => {
    const [row] = await tx.select({ stageId: deals.stageId, stageEnteredAt: deals.stageEnteredAt, slaMinutes: pipelineStages.slaMinutes })
      .from(deals).innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(eq(deals.id, event.dealId!));
    return row;
  });
  if (!target?.slaMinutes) return;

  const stageEnteredAt = target.stageEnteredAt.toISOString();
  const job: SlaCheckJob = {
    dealId: event.dealId, stageId: target.stageId, stageEnteredAt, slaMinutes: target.slaMinutes,
    organizationId: event.organizationId, workspaceId: event.workspaceId,
  };
  const delay = Math.max(0, target.stageEnteredAt.getTime() + target.slaMinutes * 60_000 - Date.now());
  await deps.queues.automations.add('sla-check', job, {
    jobId: slaJobId(job.dealId, job.stageId, stageEnteredAt),
    delay,
    removeOnComplete: { age: 86_400 },
  });
}

/**
 * Срабатывание таймера. Проверка в момент срабатывания авторитетна: если сделка ушла из этапа
 * (или вернулась в него позже — другой stage_entered_at) или закрыта, таймер устарел и молча
 * завершается. Поэтому отложенную задачу при перемещении можно не удалять — гонки «двинули
 * в ту же миллисекунду» нет. Само нарушение — событие deal.sla_breached: что с ним делать
 * (эскалация, задача, уведомление), решают автоматизации на триггер StageSlaBreached.
 */
export async function handleSlaCheck(deps: WorkerDeps, job: SlaCheckJob): Promise<boolean> {
  const ctx = systemContext(job.organizationId, job.workspaceId);
  return withRls(deps.db, ctx, async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, job.dealId)).for('update');
    const stillThere = deal && !deal.closedAt && deal.stageId === job.stageId
      && deal.stageEnteredAt.toISOString() === job.stageEnteredAt;
    if (!stillThere) return false;

    await appendOutbox(tx, {
      organizationId: job.organizationId, workspaceId: job.workspaceId, type: 'deal.sla_breached', dealId: job.dealId,
      payload: { stageId: job.stageId, minutesInStage: Math.floor((Date.now() - deal.stageEnteredAt.getTime()) / 60_000) },
      actor: { kind: 'system' },
    });
    return true;
  });
}
