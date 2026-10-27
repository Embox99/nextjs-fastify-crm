import { createDb } from '../client';
import { createSecretBox } from '../secrets';
import { DEMO_ORG, DEMO_PASSWORD, seedDemo } from './demo';

const url = process.env.MIGRATION_DATABASE_URL;
const secretsKey = process.env.SECRETS_KEY;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
if (!secretsKey) throw new Error('SECRETS_KEY is not set');

const { db, close } = createDb(url, { max: 1 });
try {
  const seed = await seedDemo(db, createSecretBox(secretsKey));
  console.log(`demo data ready: organization "${DEMO_ORG}", workspace ${seed.workspaceId}`);
  console.log(`login as admin@ / lead@ / rep1@ / rep2@ / rep3@acme.test, password "${DEMO_PASSWORD}"`);
  console.log(`webhook channels: website ${seed.channels.website}, telegram ${seed.channels.telegram}`);
} finally {
  await close();
}
