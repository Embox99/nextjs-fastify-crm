import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { runMigrations } from './migrate';

export const TEST_APP_USER = 'crm_app_user';

export interface TestDatabase {
  /** Суперпользователь контейнера: сиды и проверки в обход RLS */
  adminUrl: string;
  /** Логин-роль приложения (член crm_app): всё проходит через RLS */
  appUrl: string;
  stop(): Promise<void>;
}

/** Postgres в Testcontainers с применёнными миграциями и логин-ролью приложения. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const adminUrl = container.getConnectionUri();

  await runMigrations(adminUrl);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create role ${TEST_APP_USER} login password '${TEST_APP_USER}' in role crm_app`);
  await admin.end();

  const appUrl = new URL(adminUrl);
  appUrl.username = TEST_APP_USER;
  appUrl.password = TEST_APP_USER;

  return { adminUrl, appUrl: appUrl.toString(), stop: async () => void (await container.stop()) };
}
