import { createServer } from 'node:http';
import { QUEUES, type IngestJob } from '@crm/contracts';
import { createDb, createSecretBox } from '@crm/db';
import { createPublisher } from '@crm/realtime';
import { Emitter } from '@socket.io/redis-emitter';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Logger } from './deps';
import { startWorkers } from './workers';

const env = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  SECRETS_KEY: z.string().min(40),
  TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().default(10),
  HEALTH_PORT: z.coerce.number().int().default(4001),
}).parse(process.env);

const log: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

// Тот же app-логин, что у API: воркер работает через RLS в системном контексте workspace
const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: env.INGEST_CONCURRENCY + 5 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const ingestQueue = new Queue<IngestJob>(QUEUES.ingest, { connection: redis });

const workers = await startWorkers({
  db,
  secrets: createSecretBox(env.SECRETS_KEY),
  // Воркер не держит сокетов: события уходят через Redis тем же адаптерам, что слушают реплики API
  publisher: createPublisher(new Emitter(redis)),
  ingestQueue,
  log,
  fetch,
  telegramApiUrl: env.TELEGRAM_API_URL,
}, { connection: redis, ingestConcurrency: env.INGEST_CONCURRENCY });

// Liveness для оркестратора: процесс жив и Redis отвечает
const health = createServer(async (req, res) => {
  const ok = req.url === '/health' && (await redis.ping().then(() => true, () => false));
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
}).listen(env.HEALTH_PORT);

log.info({ queues: Object.values(QUEUES), healthPort: env.HEALTH_PORT }, 'worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down');
    health.close();
    await workers.close();
    await ingestQueue.close();
    await Promise.all([closeDb(), redis.quit()]);
    process.exit(0);
  });
}
