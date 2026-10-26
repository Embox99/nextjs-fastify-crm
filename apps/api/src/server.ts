import { createDb } from '@crm/db';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const app = await buildApp({ db, redis, jwtSecret: env.JWT_SECRET, corsOrigin: env.CORS_ORIGIN, logger: true });

app.addHook('onClose', async () => {
  await Promise.all([closeDb(), redis.quit()]);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
