import { bigint, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Только для чтения из приложения. Таблица партиционирована и пишется триггером app.audit(),
 * поэтому создаётся ручной миграцией и намеренно не входит в схему drizzle-kit.
 */
export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).notNull(),
  organizationId: uuid('organization_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  actorId: uuid('actor_id'),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  action: text('action').$type<'insert' | 'update' | 'delete'>().notNull(),
  diff: jsonb('diff').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
