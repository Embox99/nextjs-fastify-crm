import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // audit_logs (партиционированная) и всё RLS живут в ручной миграции — drizzle-kit их не видит
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgres://crm_owner:crm_owner@localhost:5434/crm',
  },
  strict: true,
});
