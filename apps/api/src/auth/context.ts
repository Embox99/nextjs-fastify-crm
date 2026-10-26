import { loadAuthContext, type AuthContext, type Db } from '@crm/db';
import type { Redis } from 'ioredis';
import type { TokenService } from './tokens';

const CACHE_TTL_SEC = 60;

export class UnauthorizedError extends Error {}

interface CachedContext extends Omit<AuthContext, 'permissions'> {
  permissions: string[];
}

/**
 * Токен → AuthContext для конкретного workspace. Контекст кэшируется в Redis на минуту:
 * это рекурсивный CTE по командам, считать его на каждый запрос и каждое WS-подключение незачем.
 * Смена роли/команды вступает в силу максимум через CACHE_TTL_SEC (или сразу — через invalidate).
 */
export function createAuthResolver(deps: { db: Db; redis: Redis; tokens: TokenService }) {
  const key = (userId: string, workspaceId: string) => `authctx:${userId}:${workspaceId}`;

  return {
    async resolve(token: string | undefined, workspaceId: string | undefined): Promise<AuthContext> {
      if (!token || !workspaceId) throw new UnauthorizedError('missing token or workspace');

      const claims = await deps.tokens.verify(token).catch(() => {
        throw new UnauthorizedError('invalid token');
      });

      const cached = await deps.redis.get(key(claims.userId, workspaceId));
      if (cached) {
        const ctx = JSON.parse(cached) as CachedContext;
        return { ...ctx, permissions: new Set(ctx.permissions) };
      }

      const ctx = await loadAuthContext(deps.db, claims.userId, workspaceId);
      // Токен одной организации не открывает workspace другой, даже если membership существует
      if (ctx.organizationId !== claims.organizationId) throw new UnauthorizedError('organization mismatch');

      const serializable: CachedContext = { ...ctx, permissions: [...ctx.permissions] };
      await deps.redis.set(key(claims.userId, workspaceId), JSON.stringify(serializable), 'EX', CACHE_TTL_SEC);
      return ctx;
    },

    invalidate: (userId: string, workspaceId: string) => deps.redis.del(key(userId, workspaceId)),
  };
}

export type AuthResolver = ReturnType<typeof createAuthResolver>;

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}
