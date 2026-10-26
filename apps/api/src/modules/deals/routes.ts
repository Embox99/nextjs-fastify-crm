import { CreateDealInput, MoveDealInput, UpdateDealInput, type DealDto } from '@crm/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth';
import { createDeal, moveDeal, NotFoundError, updateDeal } from './service';

const DealParams = z.object({ dealId: z.uuid() });

export async function dealsRoutes(app: FastifyInstance) {
  const notFound = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof NotFoundError) return reply.notFound();
    throw err;
  };

  app.post('/deals', {
    preHandler: requirePermission('deal:create'),
  }, async (req, reply): Promise<DealDto | void> => {
    const input = CreateDealInput.parse(req.body);
    const change = await req.tx((tx) => createDeal(tx, req.auth, input)).catch(notFound(reply));
    if (!change) return;

    app.realtime.dealUpserted(change, { actorId: req.auth.userId, clientMutationId: input.clientMutationId });
    return reply.code(201).send(change.deal);
  });

  app.patch('/deals/:dealId', {
    preHandler: requirePermission('deal:update'),
  }, async (req, reply): Promise<DealDto | void> => {
    const { dealId } = DealParams.parse(req.params);
    const input = UpdateDealInput.parse(req.body);
    const reassigning = input.ownerId !== undefined || input.teamId !== undefined;
    if (reassigning && !req.auth.permissions.has('deal:reassign')) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Missing permission deal:reassign' });
    }

    const change = await req.tx((tx) => updateDeal(tx, dealId, input)).catch(notFound(reply));
    if (!change) return;

    app.realtime.dealUpserted(change, { actorId: req.auth.userId, clientMutationId: input.clientMutationId });
    return change.deal;
  });

  app.post('/deals/:dealId/move', {
    preHandler: requirePermission('deal:update'),
  }, async (req, reply): Promise<DealDto | void> => {
    const { dealId } = DealParams.parse(req.params);
    const input = MoveDealInput.parse(req.body);

    const change = await req.tx((tx) => moveDeal(tx, dealId, input)).catch(notFound(reply));
    if (!change) return;

    // Публикация — после коммита: подписчики не увидят изменение, которое потом откатится
    app.realtime.dealUpserted(change, { actorId: req.auth.userId, clientMutationId: input.clientMutationId });
    if (change.rebalance) req.log.warn({ stageId: change.deal.stageId }, 'stage ranks need rebalancing');
    return change.deal;
  });
}
