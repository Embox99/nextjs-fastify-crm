import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Суперпользователь контейнера: сиды и проверки в обход RLS */
    adminUrl: string;
    /** Логин-роль приложения (член crm_app): всё проходит через RLS */
    appUrl: string;
  }
}

const APP_USER = 'crm_app_user';

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const adminUrl = container.getConnectionUri();

  await runMigrations(adminUrl);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create role ${APP_USER} login password '${APP_USER}' in role crm_app`);
  await admin.end();

  const appUrl = new URL(adminUrl);
  appUrl.username = APP_USER;
  appUrl.password = APP_USER;

  project.provide('adminUrl', adminUrl);
  project.provide('appUrl', appUrl.toString());
}

export async function teardown() {
  await container?.stop();
}
