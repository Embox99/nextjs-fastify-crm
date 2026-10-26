import type { TestProject } from 'vitest/node';
import { startTestDatabase, type TestDatabase } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}

let database: TestDatabase | undefined;

export async function setup(project: TestProject) {
  database = await startTestDatabase();
  project.provide('adminUrl', database.adminUrl);
  project.provide('appUrl', database.appUrl);
}

export async function teardown() {
  await database?.stop();
}
