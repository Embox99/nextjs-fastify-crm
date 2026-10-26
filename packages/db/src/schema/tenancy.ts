import {
  boolean, foreignKey, pgEnum, pgTable, primaryKey, text, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { id, organizationId, timestamps, workspaceId } from './columns';

export const visibilityScope = pgEnum('visibility_scope', ['all', 'team', 'own']);

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ...timestamps(),
});

// Составные unique (organization_id, id) / (workspace_id, id) существуют ради составных FK:
// они не дают сослаться на строку чужого тенанта (FK-проверки идут в обход RLS).

export const workspaces = pgTable('workspaces', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  ...timestamps(),
}, (t) => [unique('workspaces_org_id_uq').on(t.organizationId, t.id)]);

export const users = pgTable('users', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  fullName: text('full_name').notNull(),
  /** bcrypt (pgcrypto). Проверяется только функцией app.authenticate */
  passwordHash: text('password_hash'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps(),
}, (t) => [
  uniqueIndex('users_org_email_uq').on(t.organizationId, t.email),
  unique('users_org_id_uq').on(t.organizationId, t.id),
]);

export const roles = pgTable('roles', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  key: text('key').notNull(),
  name: text('name').notNull(),
  scope: visibilityScope('scope').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
}, (t) => [
  unique('roles_org_key_uq').on(t.organizationId, t.key),
  unique('roles_org_id_uq').on(t.organizationId, t.id),
]);

export const rolePermissions = pgTable('role_permissions', {
  organizationId: organizationId(),
  roleId: uuid('role_id').notNull(),
  permission: text('permission').notNull(),
}, (t) => [
  primaryKey({ columns: [t.roleId, t.permission] }),
  foreignKey({ columns: [t.organizationId, t.roleId], foreignColumns: [roles.organizationId, roles.id] })
    .onDelete('cascade'),
]);

export const workspaceMembers = pgTable('workspace_members', {
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.userId] }),
  foreignKey({ columns: [t.organizationId, t.workspaceId], foreignColumns: [workspaces.organizationId, workspaces.id] }),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [users.organizationId, users.id] }),
  foreignKey({ columns: [t.organizationId, t.roleId], foreignColumns: [roles.organizationId, roles.id] }),
]);

export const teams = pgTable('teams', {
  id: id(),
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  parentTeamId: uuid('parent_team_id'),
}, (t) => [
  unique('teams_ws_id_uq').on(t.workspaceId, t.id),
  foreignKey({ columns: [t.organizationId, t.workspaceId], foreignColumns: [workspaces.organizationId, workspaces.id] }),
  foreignKey({ columns: [t.workspaceId, t.parentTeamId], foreignColumns: [t.workspaceId, t.id] }),
]);

export const teamMembers = pgTable('team_members', {
  organizationId: organizationId(),
  workspaceId: workspaceId(),
  teamId: uuid('team_id').notNull(),
  userId: uuid('user_id').notNull(),
  isLead: boolean('is_lead').notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.teamId, t.userId] }),
  foreignKey({ columns: [t.workspaceId, t.teamId], foreignColumns: [teams.workspaceId, teams.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [users.organizationId, users.id] }),
]);
