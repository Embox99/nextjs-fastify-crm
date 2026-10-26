import { NotAWorkspaceMemberError } from '@crm/db';
import { RankConflictError } from '@crm/domain';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { UnauthorizedError } from '../auth/context';

export class ConflictError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}

/** drizzle оборачивает ошибку драйвера: код Postgres лежит в cause */
const pgCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, req, reply) => {
    const err: unknown = error;
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Validation failed', issues: err.issues });
    }
    if (err instanceof UnauthorizedError) return reply.code(401).send({ error: 'Unauthorized', message: err.message });
    if (err instanceof NotAWorkspaceMemberError) return reply.code(403).send({ error: 'Forbidden', message: err.message });
    if (err instanceof RankConflictError) {
      return reply.code(409).send({ error: 'Conflict', message: 'Board changed, refetch and retry' });
    }
    if (err instanceof ConflictError) {
      return reply.code(409).send({ error: 'Conflict', message: err.message, current: err.details });
    }

    switch (pgCode(err)) {
      case '42501': // RLS WITH CHECK: строка вышла бы из зоны видимости пользователя
        return reply.code(403).send({ error: 'Forbidden', message: 'Not allowed by access policy' });
      case '23503': // составной FK: ссылка на сущность чужого workspace/воронки
        return reply.code(422).send({ error: 'Unprocessable Entity', message: 'Referenced entity not found' });
    }

    const { statusCode } = error as FastifyError;
    if (statusCode && statusCode < 500) return reply.send(error);
    req.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal Server Error' });
  });
}
