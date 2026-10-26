import { withRls, type AuthContext, type Tx } from '@crm/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { bearerToken } from '../auth/context';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
    /** Транзакция с RLS-контекстом текущего пользователя */
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export const authPlugin = fp(async (app) => {
  app.decorateRequest('auth', null as unknown as AuthContext);
  app.decorateRequest('tx', null as unknown as FastifyRequest['tx']);

  app.addHook('onRequest', async (req) => {
    // Нет маршрута — пусть Fastify ответит 404, а не 401
    if (req.routeOptions.config.public || !req.routeOptions.url) return;

    const workspaceId = req.headers['x-workspace-id'];
    const auth = await app.authResolver.resolve(
      bearerToken(req.headers.authorization),
      typeof workspaceId === 'string' ? workspaceId : undefined,
    );
    req.auth = auth;
    req.tx = (fn) => withRls(app.db, auth, fn);
  });
});

/** Проверка действия. Какие строки доступны — решает RLS, здесь только «можно ли это делать вообще». */
export const requirePermission = (permission: string) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!req.auth.permissions.has(permission)) {
    return reply.code(403).send({ error: 'Forbidden', message: `Missing permission ${permission}` });
  }
};
