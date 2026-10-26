import type { BoardDto, PipelineDto } from '@crm/contracts';
import { deals, pipelineStages, pipelines, users, workspaceMembers } from '@crm/db';
import { compareByRank } from '@crm/domain';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth';
import { toDealDto } from '../deals/dto';

const PipelineParams = z.object({ pipelineId: z.uuid() });

export async function pipelinesRoutes(app: FastifyInstance) {
  app.get('/pipelines', async (req): Promise<PipelineDto[]> =>
    req.tx((tx) => tx.select({ id: pipelines.id, name: pipelines.name }).from(pipelines).orderBy(asc(pipelines.name))));

  // Ни одного условия про роли: какие сделки попадут на доску, решает RLS
  app.get('/pipelines/:pipelineId/board', {
    preHandler: requirePermission('deal:read'),
  }, async (req, reply): Promise<BoardDto | void> => {
    const { pipelineId } = PipelineParams.parse(req.params);

    const board = await req.tx(async (tx) => {
      const [pipeline] = await tx.select({ id: pipelines.id, name: pipelines.name })
        .from(pipelines).where(eq(pipelines.id, pipelineId));
      if (!pipeline) return null;

      const [stages, dealRows, members] = await Promise.all([
        tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(asc(pipelineStages.rank)),
        tx.select().from(deals).where(eq(deals.pipelineId, pipelineId)),
        tx.select({ id: users.id, fullName: users.fullName })
          .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
          .orderBy(asc(users.fullName)),
      ]);
      return { pipeline, stages, dealRows, members };
    });
    if (!board) return reply.notFound();

    return {
      pipeline: board.pipeline,
      stages: board.stages.map((s) => ({
        id: s.id, pipelineId: s.pipelineId, name: s.name, rank: s.rank, kind: s.kind, slaMinutes: s.slaMinutes,
      })),
      deals: board.dealRows.map(toDealDto).sort(compareByRank),
      members: board.members,
    };
  });
}
