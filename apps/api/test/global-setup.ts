import { createDb, createSecretBox, seedDemo, type DemoSeed } from '@crm/db';
import { startTestDatabase, TEST_SECRETS_KEY, type TestDatabase } from '@crm/db/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
    redisUrl: string;
    demo: DemoSeed;
  }
}

let database: TestDatabase | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject) {
  [database, redis] = await Promise.all([startTestDatabase(), new RedisContainer('redis:7-alpine').start()]);

  const admin = createDb(database.adminUrl, { max: 1 });
  const demo = await seedDemo(admin.db, createSecretBox(TEST_SECRETS_KEY));
  await admin.close();

  project.provide('adminUrl', database.adminUrl);
  project.provide('appUrl', database.appUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('demo', demo);
}

export async function teardown() {
  await Promise.all([database?.stop(), redis?.stop()]);
}
