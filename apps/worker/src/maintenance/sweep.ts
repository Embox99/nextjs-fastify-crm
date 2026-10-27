import { ingestJobId } from '@crm/contracts';
import { sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';

/** Сколько событие может пролежать в received, прежде чем sweeper сочтёт его потерянным */
export const STALE_AFTER = '1 minute';
const BATCH = 500;

/**
 * Страховка между коммитом события и постановкой в очередь: API мог упасть после INSERT
 * до queue.add. Повторная постановка с тем же jobId идемпотентна (BullMQ игнорирует дубль),
 * а обработчик под FOR UPDATE пропускает уже обработанные события.
 */
export async function sweepStaleInboundEvents(deps: WorkerDeps): Promise<number> {
  const stale = await deps.db.execute<{ id: string; organization_id: string; workspace_id: string }>(
    sql`select * from app.stale_inbound_events(${STALE_AFTER}::interval, ${BATCH})`,
  );
  if (stale.length === 0) return 0;

  await deps.queues.ingest.addBulk(stale.map((e) => ({
    name: 'ingest',
    data: { inboundEventId: e.id, organizationId: e.organization_id, workspaceId: e.workspace_id },
    opts: { jobId: ingestJobId(e.id) },
  })));
  deps.log.warn({ count: stale.length }, 're-enqueued stale inbound events');
  return stale.length;
}
