import { sql } from 'drizzle-orm';
import {
  boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { id, organizationId, timestamps, workspaceId } from './columns';
import { contacts, deals, pipelines } from './crm';
import { teams, users, workspaces } from './tenancy';

export const channelKind = pgEnum('channel_kind', ['website_form', 'telegram']);
export const inboundStatus = pgEnum('inbound_status', ['received', 'processed', 'failed']);
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const deliveryStatus = pgEnum('delivery_status', ['received', 'pending', 'sent', 'failed']);
export const mergeStatus = pgEnum('merge_status', ['open', 'merged', 'dismissed']);

const tenantFk = (t: { organizationId: any; workspaceId: any }) =>
  foreignKey({ columns: [t.organizationId, t.workspaceId], foreignColumns: [workspaces.organizationId, workspaces.id] });

/**
 * Подключённый источник лидов. Секреты (HMAC-ключ сайта, secret token и bot token Telegram)
 * хранятся зашифрованными (AES-256-GCM, ключ вне БД) и читаются только через app.webhook_channel().
 */
export const channels = pgTable('channels', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  kind: channelKind('kind').notNull(),
  name: text('name').notNull(),
  /** Секрет проверки входящих запросов; previous — для бесшовной ротации */
  webhookSecret: text('webhook_secret').notNull(),
  previousWebhookSecret: text('previous_webhook_secret'),
  /** Токен для исходящих сообщений (Telegram Bot API) */
  outboundToken: text('outbound_token'),
  defaultPipelineId: uuid('default_pipeline_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps(),
}, (t) => [
  unique('channels_ws_id_uq').on(t.workspaceId, t.id),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.defaultPipelineId], foreignColumns: [pipelines.workspaceId, pipelines.id] }),
]);

/**
 * Сырые входящие события. Пишутся до любой бизнес-логики: если нормализатор упал из-за
 * смены формата у провайдера, событие можно переиграть. unique — источник истины идемпотентности.
 */
export const inboundEvents = pgTable('inbound_events', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  channelId: uuid('channel_id').notNull(),
  externalId: text('external_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: inboundStatus('status').notNull().default('received'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [
  unique('inbound_events_channel_external_uq').on(t.channelId, t.externalId),
  index('inbound_events_pending_idx').on(t.receivedAt).where(sql`status = 'received'`),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.channelId], foreignColumns: [channels.workspaceId, channels.id] }),
]);

/** Диалог с контактом в канале. Видимость — как у сделки: по ответственному и команде. */
export const conversations = pgTable('conversations', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  channelId: uuid('channel_id').notNull(),
  /** chat.id в Telegram, email/телефон для формы сайта */
  externalThreadId: text('external_thread_id').notNull(),
  contactId: uuid('contact_id').notNull(),
  dealId: uuid('deal_id'),
  assigneeId: uuid('assignee_id'),
  teamId: uuid('team_id'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  lastMessagePreview: text('last_message_preview'),
  ...timestamps(),
}, (t) => [
  unique('conversations_ws_id_uq').on(t.workspaceId, t.id),
  unique('conversations_channel_thread_uq').on(t.channelId, t.externalThreadId),
  index('conversations_inbox_idx').on(t.workspaceId, t.lastMessageAt),
  // Для политики contacts_visibility: «контакт виден, если виден его диалог»
  index('conversations_contact_idx').on(t.contactId),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.channelId], foreignColumns: [channels.workspaceId, channels.id] }),
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
  foreignKey({ columns: [t.workspaceId, t.dealId], foreignColumns: [deals.workspaceId, deals.id] }),
  foreignKey({ columns: [t.workspaceId, t.teamId], foreignColumns: [teams.workspaceId, teams.id] }),
  foreignKey({ columns: [t.organizationId, t.assigneeId], foreignColumns: [users.organizationId, users.id] }),
]);

export const messages = pgTable('messages', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  conversationId: uuid('conversation_id').notNull(),
  direction: messageDirection('direction').notNull(),
  body: text('body').notNull(),
  /** id сообщения у провайдера: защищает от повторной вставки при ретраях */
  externalId: text('external_id'),
  authorId: uuid('author_id'),
  deliveryStatus: deliveryStatus('delivery_status').notNull(),
  deliveryError: text('delivery_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // direction в ключе: у входящих и исходящих id провайдера могут быть из разных пространств
  unique('messages_conversation_external_uq').on(t.conversationId, t.direction, t.externalId),
  index('messages_conversation_idx').on(t.conversationId, t.createdAt),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.conversationId], foreignColumns: [conversations.workspaceId, conversations.id] })
    .onDelete('cascade'),
  foreignKey({ columns: [t.organizationId, t.authorId], foreignColumns: [users.organizationId, users.id] }),
]);

/** Идентификаторы лида указывают на разные контакты — не мёржим молча, а ставим задачу на ревью */
export const mergeCandidates = pgTable('merge_candidates', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  contactIds: uuid('contact_ids').array().notNull(),
  reason: text('reason').notNull(),
  status: mergeStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Один и тот же конфликт (одинаковый отсортированный набор контактов) — одна задача
  unique('merge_candidates_ws_contacts_uq').on(t.workspaceId, t.contactIds),
  tenantFk(t),
]);
