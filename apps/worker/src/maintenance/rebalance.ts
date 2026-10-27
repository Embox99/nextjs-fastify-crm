import type { RebalanceJob } from '@crm/contracts';
import { deals, systemContext, withRls } from '@crm/db';
import { evenRanks } from '@crm/domain';
import { asc, eq, sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';

/**
 * Перенумерация колонки ровными ключами одним UPDATE ... FROM (VALUES ...).
 * Порядок сохраняется (тот же rank, id), блокировка строк колонки не даёт перемещению
 * вклиниться между чтением и записью. Клиенты получают stage.rebalanced и перезапрашивают доску.
 */
export async function rebalanceStage(deps: WorkerDeps, job: RebalanceJob): Promise<number> {
  const count = await withRls(deps.db, systemContext(job.organizationId, job.workspaceId), async (tx) => {
    const rows = await tx.select({ id: deals.id }).from(deals)
      .where(eq(deals.stageId, job.stageId)).orderBy(asc(deals.rank), asc(deals.id)).for('update');
    if (rows.length === 0) return 0;

    const ranks = evenRanks(rows.length);
    const values = sql.join(rows.map((r, i) => sql`(${r.id}::uuid, ${ranks[i]!})`), sql`, `);
    await tx.execute(sql`
      update deals set rank = v.rank
      from (values ${values}) as v(id, rank)
      where deals.id = v.id`);
    return rows.length;
  });

  if (count) deps.publisher.stageRebalanced(job.workspaceId, job.pipelineId, job.stageId);
  return count;
}
