import { QUEUES, type DeliverJob, type IngestJob, type RebalanceJob } from '@crm/contracts';
import { createSecretBox, type Db, type SecretBox } from '@crm/db';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { Queue } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createAuthResolver, type AuthResolver } from './auth/context';
import { createTokenService, type TokenService } from './auth/tokens';
import { authRoutes } from './modules/auth/routes';
import { automationsRoutes } from './modules/automations/routes';
import { channelsRoutes } from './modules/channels/routes';
import { dealsRoutes } from './modules/deals/routes';
import { inboxRoutes } from './modules/inbox/routes';
import { notificationsRoutes } from './modules/notifications/routes';
import { pipelinesRoutes } from './modules/pipelines/routes';
import { webhookRoutes } from './modules/webhooks/routes';
import { authPlugin } from './plugins/auth';
import { registerErrorHandler } from './plugins/errors';
import { realtimePlugin } from './realtime/plugin';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    redis: Redis;
    tokens: TokenService;
    authResolver: AuthResolver;
    secrets: SecretBox;
    queues: { ingest: Queue<IngestJob>; deliver: Queue<DeliverJob>; maintenance: Queue<RebalanceJob> };
  }
}

export interface AppDeps {
  db: Db;
  /** Клиент с maxRetriesPerRequest: null — его же используют очереди BullMQ */
  redis: Redis;
  jwtSecret: string;
  secretsKey: string;
  corsOrigin: string[];
  logger?: boolean;
}

/** Фабрика без побочных эффектов: соединения передаются снаружи, поэтому тесты поднимают несколько реплик. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

  const tokens = createTokenService(deps.jwtSecret);
  app.decorate('db', deps.db);
  app.decorate('redis', deps.redis);
  app.decorate('tokens', tokens);
  app.decorate('authResolver', createAuthResolver({ db: deps.db, redis: deps.redis, tokens }));
  app.decorate('secrets', createSecretBox(deps.secretsKey));

  // Ретраи с экспоненциальной паузой: сбой БД/Redis на минуту не теряет лиды
  const defaultJobOptions = {
    attempts: 8,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 7 * 86_400 },
  };
  app.decorate('queues', {
    ingest: new Queue<IngestJob>(QUEUES.ingest, { connection: deps.redis, defaultJobOptions }),
    deliver: new Queue<DeliverJob>(QUEUES.deliver, { connection: deps.redis, defaultJobOptions: { ...defaultJobOptions, attempts: 5 } }),
    maintenance: new Queue<RebalanceJob>(QUEUES.maintenance, { connection: deps.redis }),
  });
  app.addHook('onClose', async () => {
    await Promise.all(Object.values(app.queues).map((q) => q.close()));
  });

  await app.register(sensible);
  // methods задаём явно: по умолчанию @fastify/cors разрешает только GET/HEAD/POST, и браузер режет PATCH на preflight
  await app.register(cors, {
    origin: deps.corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-workspace-id'],
  });
  registerErrorHandler(app);

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  await app.register(authPlugin);
  await app.register(realtimePlugin, { corsOrigin: deps.corsOrigin });
  await app.register(authRoutes);
  await app.register(pipelinesRoutes);
  await app.register(dealsRoutes);
  await app.register(inboxRoutes);
  await app.register(channelsRoutes);
  await app.register(automationsRoutes);
  await app.register(notificationsRoutes);
  await app.register(webhookRoutes);

  return app;
}
