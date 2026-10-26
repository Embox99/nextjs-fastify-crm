import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

// Фабрики, а не общие инстансы: билдер колонки нельзя переиспользовать между таблицами
export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const organizationId = () => uuid('organization_id').notNull();
export const workspaceId = () => uuid('workspace_id').notNull();

export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Ключ fractional indexing. collate "C" — побайтовое сравнение, совпадающее с JS `<`. */
export const rankKey = customType<{ data: string; driverData: string }>({
  dataType: () => 'text collate "C"',
});
