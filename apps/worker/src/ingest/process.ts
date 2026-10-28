import type { ConversationDto, DealDto, IngestJob, MessageDto, NormalizedLead } from '@crm/contracts';
import {
  activities, appendOutbox, channels, conversations, deals, inboundEvents, loadConversationDto, messages, pipelineStages,
  systemContext, toDealDto, toMessageDto, withRls, type Tx,
} from '@crm/db';
import { rankBetween } from '@crm/domain';
import { and, asc, desc, eq, isNull, min, sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';
import { IgnoredEventError, normalize, NormalizationError } from './normalize';
import { resolveContact } from './resolve-contact';

export type IngestOutcome = 'processed' | 'ignored' | 'invalid' | 'already_done' | 'missing';

interface Published {
  deal: DealDto | null;
  conversation: ConversationDto;
  message: MessageDto | null;
}

const preview = (body: string) => body.slice(0, 140);

/**
 * Сырое событие → контакт (с дедупликацией) → сделка → диалог → сообщение. Одна транзакция:
 * повтор джобы после сбоя на любом шаге безопасен, а FOR UPDATE на событии не даёт двум
 * исполнителям (ретрай + sweeper) обработать его одновременно.
 */
export async function processInboundEvent(deps: WorkerDeps, job: IngestJob): Promise<IngestOutcome> {
  const ctx = systemContext(job.organizationId, job.workspaceId);

  let outcome: IngestOutcome = 'processed';
  let published: Published | null = null;
  try {
    published = await withRls(deps.db, ctx, async (tx) => {
      const [event] = await tx.select().from(inboundEvents).where(eq(inboundEvents.id, job.inboundEventId)).for('update');
      if (!event) {
        outcome = 'missing';
        return null;
      }
      if (event.status !== 'received') {
        outcome = 'already_done';
        return null;
      }

      const [channel] = await tx.select({ id: channels.id, kind: channels.kind, defaultPipelineId: channels.defaultPipelineId })
        .from(channels).where(eq(channels.id, event.channelId));
      const lead = normalize(channel!.kind, event.payload, event.externalId);

      const { contactId } = await resolveContact(tx, ctx, lead);
      const deal = await findOrCreateDeal(tx, ctx.organizationId, ctx.workspaceId, channel!.defaultPipelineId, contactId, lead);
      if (deal.created) {
        // Триггер LeadCreated: распределение, уведомления, SLA первого этапа
        await appendOutbox(tx, {
          organizationId: ctx.organizationId, workspaceId: ctx.workspaceId, type: 'lead.created',
          dealId: deal.row.id, payload: { channelId: channel!.id }, actor: { kind: 'system' },
        });
      }
      const conversationId = await upsertConversation(tx, {
        organizationId: ctx.organizationId, workspaceId: ctx.workspaceId, channelId: channel!.id, lead, contactId, deal: deal.row,
      });
      const message = lead.message ? await insertInboundMessage(tx, ctx, conversationId, lead) : null;
      if (message) {
        await tx.insert(activities).values({
          organizationId: ctx.organizationId, workspaceId: ctx.workspaceId, dealId: deal.row.id, contactId,
          type: 'message', payload: { conversationId, messageId: message.id, preview: preview(message.body) },
        });
      }
      await tx.update(deals).set({ lastActivityAt: sql`now()` }).where(eq(deals.id, deal.row.id));

      await markEvent(tx, event.id, 'processed');
      return {
        deal: deal.created ? toDealDto(deal.row) : null,
        conversation: (await loadConversationDto(tx, conversationId))!,
        message,
      };
    });
  } catch (err) {
    if (!(err instanceof NormalizationError) && !(err instanceof IgnoredEventError)) throw err;
    // Ретраи не помогут: фиксируем результат на событии, payload остаётся для разбора и replay
    outcome = err instanceof IgnoredEventError ? 'ignored' : 'invalid';
    await withRls(deps.db, ctx, (tx) =>
      markEvent(tx, job.inboundEventId, outcome === 'ignored' ? 'processed' : 'failed', err.message));
    deps.log.warn({ inboundEventId: job.inboundEventId, reason: err.message }, `inbound event ${outcome}`);
  }

  // Публикация после коммита — подписчики не увидят того, что потом откатится
  if (published) {
    if (published.deal) deps.publisher.dealUpserted({ deal: published.deal }, { actorId: null });
    deps.publisher.conversationUpserted(published.conversation);
    if (published.message) deps.publisher.messageCreated(published.conversation, published.message);
  }
  return outcome;
}

async function markEvent(tx: Tx, id: string, status: 'processed' | 'failed', error?: string) {
  await tx.update(inboundEvents).set({
    status,
    error: error ?? null,
    attempts: sql`${inboundEvents.attempts} + 1`,
    processedAt: sql`now()`,
  }).where(and(eq(inboundEvents.id, id), eq(inboundEvents.status, 'received')));
}

type DealRow = typeof deals.$inferSelect;

/**
 * Повторное обращение того же клиента не плодит сделки: открытая сделка контакта в воронке
 * канала переиспользуется. Новая сделка — наверх первого открытого этапа, без ответственного:
 * распределение — задача движка автоматизаций (round-robin).
 */
async function findOrCreateDeal(
  tx: Tx, organizationId: string, workspaceId: string, pipelineId: string, contactId: string, lead: NormalizedLead,
): Promise<{ row: DealRow; created: boolean }> {
  const [open] = await tx.select().from(deals)
    .where(and(eq(deals.contactId, contactId), eq(deals.pipelineId, pipelineId), isNull(deals.closedAt)))
    .orderBy(desc(deals.createdAt)).limit(1);
  if (open) return { row: open, created: false };

  const [stage] = await tx.select({ id: pipelineStages.id }).from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.kind, 'open')))
    .orderBy(asc(pipelineStages.rank)).limit(1);
  const [top] = await tx.select({ rank: min(deals.rank) }).from(deals).where(eq(deals.stageId, stage!.id));

  const who = lead.name ?? lead.phone ?? lead.email ?? 'new contact';
  const [row] = await tx.insert(deals).values({
    organizationId, workspaceId, pipelineId,
    stageId: stage!.id,
    rank: rankBetween(null, top?.rank ?? null),
    title: lead.dealTitle ?? `Lead: ${who}`,
    contactId,
  }).returning();
  return { row: row!, created: true };
}

/**
 * Диалог по (канал, ключ треда у провайдера). ON CONFLICT вместо select-then-insert:
 * два сообщения одного чата, обработанные параллельно, не создадут два диалога.
 */
async function upsertConversation(tx: Tx, p: {
  organizationId: string; workspaceId: string; channelId: string; lead: NormalizedLead; contactId: string; deal: DealRow;
}): Promise<string> {
  const now = sql`now()`;
  const [row] = await tx.insert(conversations).values({
    organizationId: p.organizationId,
    workspaceId: p.workspaceId,
    channelId: p.channelId,
    externalThreadId: p.lead.threadId,
    contactId: p.contactId,
    dealId: p.deal.id,
    assigneeId: p.deal.ownerId,
    teamId: p.deal.teamId,
    lastMessagePreview: p.lead.message ? preview(p.lead.message) : null,
  }).onConflictDoUpdate({
    target: [conversations.channelId, conversations.externalThreadId],
    set: {
      lastMessageAt: now,
      updatedAt: now,
      ...(p.lead.message && { lastMessagePreview: preview(p.lead.message) }),
      dealId: sql`coalesce(${conversations.dealId}, excluded.deal_id)`,
    },
  }).returning({ id: conversations.id });
  return row!.id;
}

async function insertInboundMessage(tx: Tx, ctx: { organizationId: string; workspaceId: string }, conversationId: string, lead: NormalizedLead) {
  const [row] = await tx.insert(messages).values({
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    conversationId,
    direction: 'inbound',
    body: lead.message!,
    externalId: lead.messageId,
    deliveryStatus: 'received',
  }).onConflictDoNothing().returning();
  return row ? toMessageDto(row) : null;
}
