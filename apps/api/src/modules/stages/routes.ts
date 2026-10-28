import { CreateStageInput, DeleteStageQuery, MoveStageInput, UpdateStageInput, type StageDto } from '@crm/contracts';
import {
  appendOutbox, automations, deals, pipelineStages, pipelines, toDealDto, toStageDto, type Tx,
} from '@crm/db';
import { rankBetween, ranksBetween, RankConflictError } from '@crm/domain';
import { and, asc, eq, inArray, max, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth';

const PipelineParams = z.object({ pipelineId: z.uuid() });
const StageParams = z.object({ stageId: z.uuid() });

class StageError extends Error {
  constructor(readonly status: 404 | 409 | 422, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const orderedStages = (tx: Tx, pipelineId: string) =>
  tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.rank));

/** Автоматизации, которые ссылаются на этап (триггер или условие) — после удаления колонки они сломались бы молча */
async function referencingAutomations(tx: Tx, stageId: string): Promise<string[]> {
  const rows = await tx.select({ name: automations.name }).from(automations).where(or(
    sql`${automations.trigger}->>'toStageId' = ${stageId}`,
    sql`${automations.trigger}->>'fromStageId' = ${stageId}`,
    sql`${automations.trigger}->>'stageId' = ${stageId}`,
    sql`${automations.conditions}::text like ${`%${stageId}%`}`,
  ));
  return rows.map((r) => r.name);
}

/**
 * Управление колонками воронки — только scope=all: проверяет и requirePermission, и RLS
 * (политика pipeline_stages_admin), так что обход API не даёт прав больше.
 */
export async function stagesRoutes(app: FastifyInstance) {
  const admin = { preHandler: requirePermission('settings:manage') };

  const fail = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof StageError) {
      return reply.code(err.status).send({ error: err.status === 404 ? 'Not Found' : 'Conflict', message: err.message, ...err.details });
    }
    throw err;
  };

  app.post('/pipelines/:pipelineId/stages', admin, async (req, reply): Promise<StageDto | void> => {
    const { pipelineId } = PipelineParams.parse(req.params);
    const input = CreateStageInput.parse(req.body);

    const stage = await req.tx(async (tx) => {
      const [pipeline] = await tx.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.id, pipelineId));
      if (!pipeline) throw new StageError(404, 'Pipeline not found');

      const stages = await orderedStages(tx, pipelineId);
      // По умолчанию — после последней открытой колонки: «Выиграно»/«Проиграно» остаются в конце
      const after = input.afterStageId
        ? stages.find((s) => s.id === input.afterStageId)
        : stages.filter((s) => s.kind === 'open').at(-1);
      if (input.afterStageId && !after) throw new StageError(422, 'Unknown afterStageId');
      const next = after ? stages[stages.indexOf(after) + 1] : stages[0];

      const [row] = await tx.insert(pipelineStages).values({
        organizationId: req.auth.organizationId,
        workspaceId: req.auth.workspaceId,
        pipelineId,
        name: input.name,
        slaMinutes: input.slaMinutes ?? null,
        rank: rankBetween(after?.rank ?? null, next?.rank ?? null),
      }).returning();
      return toStageDto(row!);
    }).catch(fail(reply));
    if (!stage || reply.sent) return;

    app.realtime.stageUpserted(req.auth.workspaceId, stage);
    return reply.code(201).send(stage);
  });

  app.patch('/stages/:stageId', admin, async (req, reply): Promise<StageDto | void> => {
    const { stageId } = StageParams.parse(req.params);
    const input = UpdateStageInput.parse(req.body);
    const [row] = await req.tx((tx) => tx.update(pipelineStages).set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.slaMinutes !== undefined && { slaMinutes: input.slaMinutes }),
    }).where(eq(pipelineStages.id, stageId)).returning());
    if (!row) return reply.notFound();

    const stage = toStageDto(row);
    app.realtime.stageUpserted(req.auth.workspaceId, stage);
    return stage;
  });

  // Перестановка — как у карточек: клиент присылает соседей, ключ считается здесь
  app.post('/stages/:stageId/move', admin, async (req, reply): Promise<StageDto | void> => {
    const { stageId } = StageParams.parse(req.params);
    const { beforeId, afterId } = MoveStageInput.parse(req.body);

    const stage = await req.tx(async (tx) => {
      const [current] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId)).for('update');
      if (!current) throw new StageError(404, 'Stage not found');
      const ids = [beforeId, afterId].filter((x): x is string => x !== null);
      const neighbours = ids.length
        ? await tx.select().from(pipelineStages).where(and(inArray(pipelineStages.id, ids), eq(pipelineStages.pipelineId, current.pipelineId)))
        : [];
      const before = beforeId ? neighbours.find((n) => n.id === beforeId) : undefined;
      const after = afterId ? neighbours.find((n) => n.id === afterId) : undefined;
      if ((beforeId && !before) || (afterId && !after)) throw new RankConflictError(null, null);

      const [row] = await tx.update(pipelineStages)
        .set({ rank: rankBetween(before?.rank ?? null, after?.rank ?? null) })
        .where(eq(pipelineStages.id, stageId)).returning();
      return toStageDto(row!);
    }).catch(fail(reply));
    if (!stage || reply.sent) return;

    app.realtime.stageUpserted(req.auth.workspaceId, stage);
    return stage;
  });

  /**
   * Удаление. Непустую колонку удалить нельзя без moveDealsTo: сделки переезжают в конец целевой колонки
   * одним UPDATE, для каждой пишется deal.stage_changed — это настоящая смена этапа, и автоматизации
   * на неё реагируют. Последнюю открытую колонку и колонку, на которую ссылаются автоматизации, удалить нельзя.
   */
  app.delete('/stages/:stageId', admin, async (req, reply) => {
    const { stageId } = StageParams.parse(req.params);
    const { moveDealsTo } = DeleteStageQuery.parse(req.query);

    const result = await req.tx(async (tx) => {
      const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId)).for('update');
      if (!stage) throw new StageError(404, 'Stage not found');

      if (stage.kind === 'open') {
        const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(pipelineStages)
          .where(and(eq(pipelineStages.pipelineId, stage.pipelineId), eq(pipelineStages.kind, 'open')));
        // Входящие лиды попадают в первую открытую колонку — без неё ingest некуда класть сделки
        if (open!.n <= 1) throw new StageError(422, 'Cannot delete the last open stage');
      }

      const usedBy = await referencingAutomations(tx, stageId);
      if (usedBy.length) throw new StageError(409, 'Stage is used by automations', { automations: usedBy });

      const inStage = await tx.select({ id: deals.id }).from(deals)
        .where(eq(deals.stageId, stageId)).orderBy(asc(deals.rank), asc(deals.id)).for('update');
      if (inStage.length && !moveDealsTo) throw new StageError(409, 'Stage has deals', { dealCount: inStage.length });

      let moved: (typeof deals.$inferSelect)[] = [];
      if (inStage.length && moveDealsTo) {
        const [target] = await tx.select({ id: pipelineStages.id }).from(pipelineStages).where(and(
          eq(pipelineStages.id, moveDealsTo), eq(pipelineStages.pipelineId, stage.pipelineId), ne(pipelineStages.id, stageId),
        ));
        if (!target) throw new StageError(422, 'moveDealsTo must be another stage of the same pipeline');

        const [last] = await tx.select({ rank: max(deals.rank) }).from(deals).where(eq(deals.stageId, target.id));
        const ranks = ranksBetween(last?.rank ?? null, null, inStage.length);
        const values = sql.join(inStage.map((d, i) => sql`(${d.id}::uuid, ${ranks[i]!})`), sql`, `);
        await tx.execute(sql`
          update deals set stage_id = ${target.id}, rank = v.rank, stage_entered_at = now(),
                 version = deals.version + 1, updated_at = now()
          from (values ${values}) as v(id, rank)
          where deals.id = v.id`);
        moved = await tx.select().from(deals).where(inArray(deals.id, inStage.map((d) => d.id)));

        for (const deal of moved) {
          await appendOutbox(tx, {
            organizationId: req.auth.organizationId, workspaceId: req.auth.workspaceId, type: 'deal.stage_changed', dealId: deal.id,
            payload: { fromStageId: stageId, toStageId: target.id, stageEnteredAt: deal.stageEnteredAt.toISOString() },
            actor: { kind: 'user', id: req.auth.userId },
          });
        }
      }

      await tx.delete(pipelineStages).where(eq(pipelineStages.id, stageId));
      return { pipelineId: stage.pipelineId, moved };
    }).catch(fail(reply));
    if (!result || reply.sent) return;

    for (const deal of result.moved) app.realtime.dealUpserted({ deal: toDealDto(deal) }, { actorId: req.auth.userId });
    app.realtime.stageDeleted(req.auth.workspaceId, { pipelineId: result.pipelineId, stageId, movedTo: moveDealsTo ?? null });
    return reply.code(204).send();
  });
}
