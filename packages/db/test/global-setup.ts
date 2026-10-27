import type { TestProject } from 'vitest/node';
import { createDb } from '../src/client';
import { createSecretBox } from '../src/secrets';
import { seedDemo, type DemoSeed } from '../src/seed/demo';
import { startTestDatabase, TEST_SECRETS_KEY, type TestDatabase } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
    demo: DemoSeed;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject) {
  database = await startTestDatabase();

  // Демо-организация сидится один раз: файлы тестов идут параллельно и гонялись бы за slug
  const admin = createDb(database.adminUrl, { max: 1 });
  const demo = await seedDemo(admin.db, createSecretBox(TEST_SECRETS_KEY));
  await admin.close();

  project.provide('adminUrl', database.adminUrl);
  project.provide('appUrl', database.appUrl);
  project.provide('demo', demo);
}

export async function teardown() {
  await database?.stop();
}
