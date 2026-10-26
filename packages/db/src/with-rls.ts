import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client';

export type VisibilityScope = 'all' | 'team' | 'own';

/** Ровно то, что читают RLS-политики. */
export interface RlsContext {
  organizationId: string;
  workspaceId: string;
  /** null — системный актор (воркер, автоматизация) */
  userId: string | null;
  scope: VisibilityScope;
  /** Команды, где пользователь лид, вместе с подкомандами */
  teamIds: readonly string[];
}

/**
 * Выполняет fn в транзакции с выставленным RLS-контекстом.
 * set_config(..., true) действует до конца транзакции — безопасно с пулом и PgBouncer (transaction mode).
 */
export function withRls<T>(db: Db, ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id',       ${ctx.organizationId}, true),
        set_config('app.workspace_id', ${ctx.workspaceId}, true),
        set_config('app.user_id',      ${ctx.userId ?? ''}, true),
        set_config('app.scope',        ${ctx.scope}, true),
        set_config('app.team_ids',     ${`{${ctx.teamIds.join(',')}}`}, true)
    `);
    return fn(tx);
  });
}

/** Контекст для фоновых процессов: видит весь workspace, в аудите actor_id = null. */
export const systemContext = (organizationId: string, workspaceId: string): RlsContext => ({
  organizationId,
  workspaceId,
  userId: null,
  scope: 'all',
  teamIds: [],
});
