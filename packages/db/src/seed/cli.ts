import { createDb } from '../client';
import { DEMO_ORG, DEMO_PASSWORD, seedDemo } from './demo';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

const { db, close } = createDb(url, { max: 1 });
try {
  const seed = await seedDemo(db);
  console.log(`demo data ready: organization "${DEMO_ORG}", workspace ${seed.workspaceId}`);
  console.log(`login as admin@ / lead@ / rep1@ / rep2@ / rep3@acme.test, password "${DEMO_PASSWORD}"`);
} finally {
  await close();
}
