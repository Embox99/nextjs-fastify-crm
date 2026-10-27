import { sql } from 'drizzle-orm';
import {
  bigint, boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { id, organizationId, timestamps, workspaceId } from './columns';
import { deals } from './crm';
import { teams, users, workspaces } from './tenancy';

const tenantFk = (t: { organizationId: any; workspaceId: any }) =>
  foreignKey({ columns: [t.organizationId, t.workspaceId], foreignColumns: [workspaces.organizationId, workspaces.id] });

/**
 * Transactional outbox: доменное событие пишется в той же транзакции, что и изменение.
 * Relay воркера доставляет его в очередь at-least-once; идемпотентность — на стороне потребителя.
 */
export const outboxEvents = pgTable('outbox_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  type: text('type').notNull(),
  dealId: uuid('deal_id'),
  payload: jsonb('payload').notNull().default({}),
  /** {kind:'user', id} | {kind:'system'} | {kind:'automation', automationId, depth} */
  actor: jsonb('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [
  index('outbox_unpublished_idx').on(t.id).where(sql`published_at is null`),
  tenantFk(t),
]);

export const automations = pgTable('automations', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  /** Trigger из @crm/contracts — валидируется zod при записи и при чтении */
  trigger: jsonb('trigger').notNull(),
  /** Тип триггера дублируется колонкой — для индекса и выборки сканером */
  triggerType: text('trigger_type').notNull(),
  conditions: jsonb('conditions').notNull(),
  actions: jsonb('actions').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  ...timestamps(),
}, (t) => [
  unique('automations_ws_id_uq').on(t.workspaceId, t.id),
  index('automations_ws_trigger_idx').on(t.workspaceId, t.triggerType).where(sql`enabled`),
  tenantFk(t),
]);

export const automationRunStatus = pgEnum('automation_run_status', ['pending', 'succeeded', 'failed']);

/**
 * Запуск автоматизации на конкретное событие. unique(automation_id, event_key) — повторная доставка
 * события не запускает автоматизацию второй раз. completed_actions — прогресс: при ретрае
 * выполненные действия пропускаются (round-robin не сдвинется дважды).
 */
export const automationRuns = pgTable('automation_runs', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  automationId: uuid('automation_id').notNull(),
  automationVersion: integer('automation_version').notNull(),
  eventKey: text('event_key').notNull(),
  dealId: uuid('deal_id'),
  /** Глубина цепочки: событие, порождённое автоматизацией, несёт depth + 1 */
  depth: integer('depth').notNull().default(0),
  status: automationRunStatus('status').notNull().default('pending'),
  completedActions: integer('completed_actions').notNull().default(0),
  /**
   * Промежуточное состояние действий. AssignManager резервирует менеджера здесь отдельной короткой
   * транзакцией: горячая блокировка пула не держится, пока обновляется сделка, а ретрай
   * использует уже выбранного менеджера вместо повторного сдвига ротации.
   */
  state: jsonb('state').$type<{ reservedAssignee?: { actionIndex: number; userId: string; teamId: string } }>().notNull().default({}),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  unique('automation_runs_event_uq').on(t.automationId, t.eventKey),
  index('automation_runs_automation_idx').on(t.automationId, t.createdAt),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.automationId], foreignColumns: [automations.workspaceId, automations.id] })
    .onDelete('cascade'),
  foreignKey({ columns: [t.workspaceId, t.dealId], foreignColumns: [deals.workspaceId, deals.id] }).onDelete('cascade'),
]);

/** Пул распределения лидов (round-robin) — привязан к команде, сделки уходят в неё */
export const assignmentPools = pgTable('assignment_pools', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  teamId: uuid('team_id').notNull(),
  /** Позиция последнего назначенного; следующий — первый доступный после неё по кругу */
  lastPosition: integer('last_position').notNull().default(-1),
}, (t) => [
  unique('assignment_pools_ws_id_uq').on(t.workspaceId, t.id),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.teamId], foreignColumns: [teams.workspaceId, teams.id] }),
]);

export const assignmentPoolMembers = pgTable('assignment_pool_members', {
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  poolId: uuid('pool_id').notNull(),
  userId: uuid('user_id').notNull(),
  position: integer('position').notNull(),
  /** Отпуск/больничный: участник пропускается, очередь не ломается */
  isAvailable: boolean('is_available').notNull().default(true),
}, (t) => [
  primaryKey({ columns: [t.poolId, t.userId] }),
  unique('assignment_pool_members_position_uq').on(t.poolId, t.position),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.poolId], foreignColumns: [assignmentPools.workspaceId, assignmentPools.id] })
    .onDelete('cascade'),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [users.organizationId, users.id] }),
]);

export const notifications = pgTable('notifications', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  dealId: uuid('deal_id'),
  automationRunId: uuid('automation_run_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notifications_user_idx').on(t.userId, t.createdAt),
  // Действие SendNotification при ретрае не дублирует уведомление
  unique('notifications_run_user_uq').on(t.automationRunId, t.userId),
  tenantFk(t),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [users.organizationId, users.id] }),
  foreignKey({ columns: [t.workspaceId, t.dealId], foreignColumns: [deals.workspaceId, deals.id] }).onDelete('cascade'),
]);
