import type { DeliverJob } from '@crm/contracts';
import {
  channelOutboundToken, channels, conversations, messages, systemContext, toMessageDto, withRls,
} from '@crm/db';
import { UnrecoverableError } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';

/** Ошибка канала, которую ретраи не исправят (нет токена, бот заблокирован пользователем, 4xx) */
class PermanentDeliveryError extends UnrecoverableError {}

/**
 * Доставка исходящего сообщения в канал. Статус pending → sent | failed виден в UI через message.updated.
 * Временные сбои (сеть, 5xx, 429) — исключение и ретрай BullMQ; постоянные — сразу failed.
 */
export async function deliverMessage(deps: WorkerDeps, job: DeliverJob, isLastAttempt: boolean): Promise<void> {
  const ctx = systemContext(job.organizationId, job.workspaceId);

  const target = await withRls(deps.db, ctx, async (tx) => {
    const [row] = await tx.select({
      message: messages,
      threadId: conversations.externalThreadId,
      channelId: channels.id,
      channelKind: channels.kind,
      assigneeId: conversations.assigneeId,
      teamId: conversations.teamId,
    }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(eq(messages.id, job.messageId));
    if (!row || row.message.deliveryStatus !== 'pending') return null;
    return { ...row, sealedToken: await channelOutboundToken(tx, row.channelId) };
  });
  if (!target) return;

  try {
    if (target.channelKind !== 'telegram') throw new PermanentDeliveryError('Channel does not support outbound messages');
    if (!target.sealedToken) throw new PermanentDeliveryError('Telegram bot token is not configured for this channel');

    const externalId = await sendTelegram(deps, deps.secrets.open(target.sealedToken), target.threadId, target.message.body);
    await finish({ deliveryStatus: 'sent', externalId });
  } catch (err) {
    const permanent = err instanceof PermanentDeliveryError;
    if (permanent || isLastAttempt) await finish({ deliveryStatus: 'failed', deliveryError: (err as Error).message });
    throw err;
  }

  async function finish(update: { deliveryStatus: 'sent' | 'failed'; externalId?: string; deliveryError?: string }) {
    const [row] = await withRls(deps.db, ctx, (tx) =>
      tx.update(messages).set({ ...update, deliveryError: update.deliveryError ?? null })
        .where(and(eq(messages.id, job.messageId), eq(messages.deliveryStatus, 'pending')))
        .returning());
    if (row) {
      deps.publisher.messageUpdated(
        { workspaceId: job.workspaceId, assigneeId: target!.assigneeId, teamId: target!.teamId },
        toMessageDto(row),
      );
    }
  }
}

async function sendTelegram(deps: WorkerDeps, token: string, chatId: string, text: string): Promise<string> {
  const res = await deps.fetch(`${deps.telegramApiUrl}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string; result?: { message_id?: number } };

  if (res.ok && body.ok && body.result?.message_id !== undefined) return String(body.result.message_id);
  const reason = `Telegram API ${res.status}: ${body.description ?? 'unknown error'}`;
  // 429 и 5xx — временные; остальные 4xx (чат не найден, бот заблокирован) ретраями не лечатся
  if (res.status === 429 || res.status >= 500) throw new Error(reason);
  throw new PermanentDeliveryError(reason);
}
