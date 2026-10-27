import { AutomationInput, type Action, type AssignmentPoolDto, type AutomationDto, type Trigger } from '@crm/contracts';
import {
  assignmentPoolMembers, assignmentPools, automationRuns, automations, pipelineStages, users, type Tx,
} from '@crm/db';
import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth';

const Params = z.object({ automationId: z.uuid() });
const Patch = z.object({ enabled: z.boolean() }).or(AutomationInput);

type Row = typeof automations.$inferSelect;

const toDto = (r: Row, stats: AutomationDto['stats']): AutomationDto => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger as Trigger,
  conditions: r.conditions as AutomationDto['conditions'],
  actions: r.actions as Action[],
  enabled: r.enabled,
  version: r.version,
  updatedAt: r.updatedAt.toISOString(),
  stats,
});

/**
 * Ссылки внутри JSON (этапы в триггере, пулы в действиях) не покрыты FK — проверяем их явно,
 * в той же RLS-транзакции: ссылка на этап или пул чужого workspace просто не найдётся.
 */
async function invalidReferences(tx: Tx, input: AutomationInput): Promise<string | null> {
  const stageIds = [
    'toStageId' in input.trigger ? input.trigger.toStageId : undefined,
    'fromStageId' in input.trigger ? input.trigger.fromStageId : undefined,
    'stageId' in input.trigger ? input.trigger.stageId : undefined,
  ].filter((x): x is string => Boolean(x));
  if (stageIds.length) {
    const found = await tx.select({ id: pipelineStages.id }).from(pipelineStages).where(inArray(pipelineStages.id, stageIds));
    if (found.length !== new Set(stageIds).size) return 'Unknown stage in trigger';
  }
  const poolIds = input.actions.flatMap((a) => (a.type === 'AssignManager' ? [a.poolId] : []));
  if (poolIds.length) {
    const found = await tx.select({ id: assignmentPools.id }).from(assignmentPools).where(inArray(assignmentPools.id, poolIds));
    if (found.length !== new Set(poolIds).size) return 'Unknown assignment pool';
  }
  return null;
}

export async function automationsRoutes(app: FastifyInstance) {
  const admin = { preHandler: requirePermission('settings:manage') };
  const unprocessable = (reply: FastifyReply, message: string) =>
    reply.code(422).send({ error: 'Unprocessable Entity', message });

  app.get('/automations', admin, async (req): Promise<AutomationDto[]> => req.tx(async (tx) => {
    const [rows, stats] = await Promise.all([
      tx.select().from(automations).orderBy(asc(automations.createdAt)),
      tx.select({
        automationId: automationRuns.automationId,
        runs: count(),
        failed: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')::int`,
        lastRunAt: max(automationRuns.createdAt),
      }).from(automationRuns).groupBy(automationRuns.automationId),
    ]);
    const byId = new Map(stats.map((s) => [s.automationId, s]));
    return rows.map((r) => {
      const s = byId.get(r.id);
      return toDto(r, { runs: s?.runs ?? 0, failed: s?.failed ?? 0, lastRunAt: s?.lastRunAt?.toISOString() ?? null });
    });
  }));

  app.post('/automations', admin, async (req, reply): Promise<AutomationDto | void> => {
    const input = AutomationInput.parse(req.body);
    const result = await req.tx(async (tx) => {
      const problem = await invalidReferences(tx, input);
      if (problem) return { problem };
      const [row] = await tx.insert(automations).values({
        organizationId: req.auth.organizationId,
        workspaceId: req.auth.workspaceId,
        name: input.name,
        trigger: input.trigger,
        triggerType: input.trigger.type,
        conditions: input.conditions,
        actions: input.actions,
        enabled: input.enabled,
      }).returning();
      return { row: row! };
    });
    if ('problem' in result) return unprocessable(reply, result.problem!);
    return reply.code(201).send(toDto(result.row, { runs: 0, failed: 0, lastRunAt: null }));
  });

  // Либо переключение enabled, либо полная замена определения (версия растёт — запуски помнят свою)
  app.patch('/automations/:automationId', admin, async (req, reply): Promise<AutomationDto | void> => {
    const { automationId } = Params.parse(req.params);
    const patch = Patch.parse(req.body);
    const result = await req.tx(async (tx) => {
      if ('trigger' in patch) {
        const problem = await invalidReferences(tx, patch);
        if (problem) return { problem };
      }
      const [row] = await tx.update(automations).set({
        ...('trigger' in patch
          ? {
            name: patch.name, trigger: patch.trigger, triggerType: patch.trigger.type,
            conditions: patch.conditions, actions: patch.actions, enabled: patch.enabled,
          }
          : { enabled: patch.enabled }),
        version: sql`${automations.version} + 1`,
        updatedAt: sql`now()`,
      }).where(eq(automations.id, automationId)).returning();
      return { row };
    });
    if ('problem' in result) return unprocessable(reply, result.problem!);
    if (!result.row) return reply.notFound();
    return toDto(result.row, { runs: 0, failed: 0, lastRunAt: null });
  });

  app.delete('/automations/:automationId', admin, async (req, reply) => {
    const { automationId } = Params.parse(req.params);
    const deleted = await req.tx((tx) => tx.delete(automations).where(eq(automations.id, automationId)).returning({ id: automations.id }));
    return deleted.length ? reply.code(204).send() : reply.notFound();
  });

  app.get('/automations/:automationId/runs', admin, async (req) => {
    const { automationId } = Params.parse(req.params);
    const rows = await req.tx((tx) => tx.select().from(automationRuns)
      .where(eq(automationRuns.automationId, automationId)).orderBy(desc(automationRuns.createdAt)).limit(20));
    return rows.map((r) => ({
      id: r.id, eventKey: r.eventKey, dealId: r.dealId, status: r.status, completedActions: r.completedActions,
      error: r.error, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  });

  app.get('/assignment-pools', admin, async (req): Promise<AssignmentPoolDto[]> => req.tx(async (tx) => {
    const [pools, members] = await Promise.all([
      tx.select().from(assignmentPools).orderBy(asc(assignmentPools.name)),
      tx.select({
        poolId: assignmentPoolMembers.poolId, userId: assignmentPoolMembers.userId, fullName: users.fullName,
        position: assignmentPoolMembers.position, isAvailable: assignmentPoolMembers.isAvailable,
      }).from(assignmentPoolMembers).innerJoin(users, eq(users.id, assignmentPoolMembers.userId))
        .orderBy(asc(assignmentPoolMembers.position)),
    ]);
    return pools.map((p) => ({
      id: p.id, name: p.name, teamId: p.teamId,
      members: members.filter((m) => m.poolId === p.id).map(({ poolId: _, ...m }) => m),
    }));
  }));

  // Отпуск/больничный: участник выпадает из ротации, его позиция сохраняется
  app.patch('/assignment-pools/:poolId/members/:userId', admin, async (req, reply) => {
    const { poolId, userId } = z.object({ poolId: z.uuid(), userId: z.uuid() }).parse(req.params);
    const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body);
    const updated = await req.tx((tx) => tx.update(assignmentPoolMembers).set({ isAvailable })
      .where(and(eq(assignmentPoolMembers.poolId, poolId), eq(assignmentPoolMembers.userId, userId))).returning());
    return updated.length ? reply.code(204).send() : reply.notFound();
  });
}
