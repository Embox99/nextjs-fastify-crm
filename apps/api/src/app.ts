import type { Db } from '@crm/db';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createAuthResolver, type AuthResolver } from './auth/context';
import { createTokenService, type TokenService } from './auth/tokens';
import { authRoutes } from './modules/auth/routes';
import { dealsRoutes } from './modules/deals/routes';
import { pipelinesRoutes } from './modules/pipelines/routes';
import { authPlugin } from './plugins/auth';
import { registerErrorHandler } from './plugins/errors';
import { realtimePlugin } from './realtime/plugin';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    redis: Redis;
    tokens: TokenService;
    authResolver: AuthResolver;
  }
}

export interface AppDeps {
  db: Db;
  redis: Redis;
  jwtSecret: string;
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

  return app;
}
