import { deliverJobId, SendMessageInput, type ConversationDto, type DeliverJob, type MessageDto } from '@crm/contracts';
import { conversations, conversationsQuery, loadConversationDto, messages, toConversationDto, toMessageDto } from '@crm/db';
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth';

const ConversationParams = z.object({ conversationId: z.uuid() });

const preview = (body: string) => body.slice(0, 140);

export async function inboxRoutes(app: FastifyInstance) {
  // Как и на доске: какие диалоги видны — решает RLS (ответственный / команда / админ)
  app.get('/conversations', async (req): Promise<ConversationDto[]> => {
    const rows = await req.tx((tx) => conversationsQuery(tx).orderBy(desc(conversations.lastMessageAt)).limit(200));
    return rows.map(toConversationDto);
  });

  app.get('/conversations/:conversationId/messages', async (req, reply): Promise<MessageDto[] | void> => {
    const { conversationId } = ConversationParams.parse(req.params);
    const rows = await req.tx(async (tx) => {
      const [visible] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId));
      if (!visible) return null;
      return tx.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(500);
    });
    if (!rows) return reply.notFound();
    return rows.map(toMessageDto);
  });

  /**
   * Ответ клиенту: сообщение сохраняется со статусом pending, доставку в канал делает воркер.
   * HTTP-запрос не зависит от доступности Telegram, а сбой доставки виден в UI как статус.
   */
  app.post('/conversations/:conversationId/messages', {
    preHandler: requirePermission('deal:update'),
  }, async (req, reply): Promise<MessageDto | void> => {
    const { conversationId } = ConversationParams.parse(req.params);
    const input = SendMessageInput.parse(req.body);

    const result = await req.tx(async (tx) => {
      const conversation = await loadConversationDto(tx, conversationId);
      if (!conversation) return null;
      if (conversation.channelKind === 'website_form') return { unsupported: true as const };

      const [message] = await tx.insert(messages).values({
        organizationId: req.auth.organizationId,
        workspaceId: req.auth.workspaceId,
        conversationId,
        direction: 'outbound',
        body: input.body,
        authorId: req.auth.userId,
        deliveryStatus: 'pending',
      }).returning();
      await tx.update(conversations)
        .set({ lastMessageAt: message!.createdAt, lastMessagePreview: preview(input.body), updatedAt: message!.createdAt })
        .where(eq(conversations.id, conversationId));

      return {
        message: toMessageDto(message!),
        conversation: { ...conversation, lastMessageAt: message!.createdAt.toISOString(), lastMessagePreview: preview(input.body) },
      };
    });
    if (!result) return reply.notFound();
    if ('unsupported' in result) return reply.code(422).send({ error: 'Unprocessable Entity', message: 'Channel does not support replies' });

    const job: DeliverJob = { messageId: result.message.id, organizationId: req.auth.organizationId, workspaceId: req.auth.workspaceId };
    await app.queues.deliver.add('deliver', job, { jobId: deliverJobId(result.message.id) });

    app.realtime.messageCreated(result.conversation, result.message, input.clientMutationId);
    app.realtime.conversationUpserted(result.conversation);
    return reply.code(201).send(result.message);
  });
}
