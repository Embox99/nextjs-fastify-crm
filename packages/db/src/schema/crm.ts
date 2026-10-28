import { sql } from 'drizzle-orm';
import {
  foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { id, organizationId, rankKey, timestamps, workspaceId } from './columns';
import { teams, users, workspaces } from './tenancy';

export const stageKind = pgEnum('stage_kind', ['open', 'won', 'lost']);
export const identityKind = pgEnum('identity_kind', ['phone', 'email', 'telegram', 'whatsapp']);
export const activityType = pgEnum('activity_type', ['note', 'call', 'task', 'message', 'stage_change']);

const tenantFk = (t: { organizationId: any; workspaceId: any }) =>
  foreignKey({ columns: [t.organizationId, t.workspaceId], foreignColumns: [workspaces.organizationId, workspaces.id] });

export const pipelines = pgTable('pipelines', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  ...timestamps(),
}, (t) => [
  unique('pipelines_ws_id_uq').on(t.workspaceId, t.id),
  tenantFk(t),
]);

export const pipelineStages = pgTable('pipeline_stages', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  pipelineId: uuid('pipeline_id').notNull(),
  name: text('name').notNull(),
  rank: rankKey('rank').notNull(),
  kind: stageKind('kind').notNull().default('open'),
  slaMinutes: integer('sla_minutes'),
}, (t) => [
  unique('stages_pipeline_id_uq').on(t.pipelineId, t.id),
  index('stages_pipeline_rank_idx').on(t.pipelineId, t.rank),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.pipelineId], foreignColumns: [pipelines.workspaceId, pipelines.id] })
    .onDelete('cascade'),
]);

export const contacts = pgTable('contacts', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  fullName: text('full_name'),
  companyName: text('company_name'),
  ownerId: uuid('owner_id'),
  mergedIntoId: uuid('merged_into_id'),
  ...timestamps(),
}, (t) => [
  unique('contacts_ws_id_uq').on(t.workspaceId, t.id),
  index('contacts_owner_idx').on(t.workspaceId, t.ownerId),
  tenantFk(t),
  foreignKey({ columns: [t.organizationId, t.ownerId], foreignColumns: [users.organizationId, users.id] }),
  foreignKey({ columns: [t.workspaceId, t.mergedIntoId], foreignColumns: [t.workspaceId, t.id] }),
]);

export const contactIdentities = pgTable('contact_identities', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  contactId: uuid('contact_id').notNull(),
  kind: identityKind('kind').notNull(),
  value: text('value').notNull(),
}, (t) => [
  uniqueIndex('contact_identity_uq').on(t.workspaceId, t.kind, t.value),
  index('contact_identities_contact_idx').on(t.contactId),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] })
    .onDelete('cascade'),
]);

export const deals = pgTable('deals', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  pipelineId: uuid('pipeline_id').notNull(),
  stageId: uuid('stage_id').notNull(),
  rank: rankKey('rank').notNull(),
  title: text('title').notNull(),
  value: numeric('value', { precision: 14, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  contactId: uuid('contact_id'),
  ownerId: uuid('owner_id'),
  teamId: uuid('team_id'),
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  ...timestamps(),
}, (t) => [
  unique('deals_ws_id_uq').on(t.workspaceId, t.id),
  index('deals_board_idx').on(t.workspaceId, t.pipelineId, t.stageId, t.rank),
  index('deals_owner_idx').on(t.workspaceId, t.ownerId),
  index('deals_team_idx').on(t.workspaceId, t.teamId),
  index('deals_contact_idx').on(t.contactId),
  index('deals_stale_idx').on(t.workspaceId, t.lastActivityAt).where(sql`closed_at is null`),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.pipelineId], foreignColumns: [pipelines.workspaceId, pipelines.id] }),
  foreignKey({ columns: [t.pipelineId, t.stageId], foreignColumns: [pipelineStages.pipelineId, pipelineStages.id] }),
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
  foreignKey({ columns: [t.workspaceId, t.teamId], foreignColumns: [teams.workspaceId, teams.id] }),
  foreignKey({ columns: [t.organizationId, t.ownerId], foreignColumns: [users.organizationId, users.id] }),
]);

export const activities = pgTable('activities', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  dealId: uuid('deal_id'),
  contactId: uuid('contact_id'),
  type: activityType('type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  authorId: uuid('author_id'),
  /** Исполнитель задачи (type = 'task') */
  assigneeId: uuid('assignee_id'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...timestamps(),
}, (t) => [
  index('activities_deal_idx').on(t.dealId, t.createdAt),
  index('activities_contact_idx').on(t.contactId, t.createdAt),
  tenantFk(t),
  foreignKey({ columns: [t.workspaceId, t.dealId], foreignColumns: [deals.workspaceId, deals.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [contacts.workspaceId, contacts.id] }),
  foreignKey({ columns: [t.organizationId, t.authorId], foreignColumns: [users.organizationId, users.id] }),
  foreignKey({ columns: [t.organizationId, t.assigneeId], foreignColumns: [users.organizationId, users.id] }),
]);
