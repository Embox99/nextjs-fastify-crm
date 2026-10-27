import type { ConversationDto, MessageDto } from '@crm/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Db, Tx } from './client';
import { channels, contacts, conversations, messages } from './schema';

export interface WebhookChannel {
  organizationId: string;
  workspaceId: string;
  kind: 'website_form' | 'telegram';
  enabled: boolean;
  /** Зашифрованные секреты: текущий и предыдущий (ротация) */
  sealedSecrets: string[];
}

/** Канал по id из URL вебхука — до того, как известен тенант (SECURITY DEFINER функция) */
export async function findWebhookChannel(db: Db, channelId: string): Promise<WebhookChannel | null> {
  const rows = await db.execute<{
    organization_id: string; workspace_id: string; kind: WebhookChannel['kind']; enabled: boolean;
    webhook_secret: string; previous_webhook_secret: string | null;
  }>(sql`select * from app.webhook_channel(${channelId})`);
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    enabled: row.enabled,
    sealedSecrets: [row.webhook_secret, row.previous_webhook_secret].filter((s): s is string => Boolean(s)),
  };
}

/** Зашифрованный токен исходящих сообщений; требует RLS-контекст workspace канала */
export async function channelOutboundToken(tx: Tx, channelId: string): Promise<string | null> {
  const rows = await tx.execute<{ token: string | null }>(sql`select app.channel_outbound_token(${channelId}) as token`);
  return rows[0]?.token ?? null;
}

/** Колонки диалога для списка инбокса: с каналом и именем контакта */
export const conversationColumns = {
  id: conversations.id,
  workspaceId: conversations.workspaceId,
  channelId: conversations.channelId,
  channelKind: channels.kind,
  channelName: channels.name,
  contactId: conversations.contactId,
  contactName: contacts.fullName,
  dealId: conversations.dealId,
  assigneeId: conversations.assigneeId,
  teamId: conversations.teamId,
  lastMessageAt: conversations.lastMessageAt,
  lastMessagePreview: conversations.lastMessagePreview,
};

export const conversationsQuery = (tx: Tx) =>
  tx.select(conversationColumns).from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId));

type ConversationRow = Awaited<ReturnType<typeof conversationsQuery>>[number];

export const toConversationDto = (r: ConversationRow): ConversationDto => ({
  id: r.id,
  workspaceId: r.workspaceId,
  channelId: r.channelId,
  channelKind: r.channelKind,
  channelName: r.channelName,
  contactId: r.contactId,
  contactName: r.contactName,
  dealId: r.dealId,
  assigneeId: r.assigneeId,
  teamId: r.teamId,
  lastMessageAt: r.lastMessageAt.toISOString(),
  lastMessagePreview: r.lastMessagePreview,
});

export async function loadConversationDto(tx: Tx, id: string): Promise<ConversationDto | null> {
  const [row] = await conversationsQuery(tx).where(eq(conversations.id, id));
  return row ? toConversationDto(row) : null;
}

export const toMessageDto = (m: typeof messages.$inferSelect): MessageDto => ({
  id: m.id,
  conversationId: m.conversationId,
  direction: m.direction,
  body: m.body,
  authorId: m.authorId,
  deliveryStatus: m.deliveryStatus,
  deliveryError: m.deliveryError,
  createdAt: m.createdAt.toISOString(),
});
