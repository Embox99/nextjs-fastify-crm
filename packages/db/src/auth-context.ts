import { sql } from 'drizzle-orm';
import type { Db } from './client';
import type { RlsContext, VisibilityScope } from './with-rls';

export interface AuthContext extends RlsContext {
  userId: string;
  permissions: ReadonlySet<string>;
}

export class NotAWorkspaceMemberError extends Error {
  constructor(readonly userId: string, readonly workspaceId: string) {
    super(`User ${userId} is not an active member of workspace ${workspaceId}`);
  }
}

interface ResolvedRow extends Record<string, unknown> {
  organization_id: string;
  scope: VisibilityScope;
  team_ids: string[];
  permissions: string[];
}

/**
 * Собирает контекст по membership. organizationId берётся из БД, а не из запроса —
 * клиент не может подставить чужую организацию. userId обязан прийти из проверенной сессии.
 */
export async function loadAuthContext(db: Db, userId: string, workspaceId: string): Promise<AuthContext> {
  const rows = await db.execute<ResolvedRow>(
    sql`select * from app.resolve_auth_context(${userId}, ${workspaceId})`,
  );
  const row = rows[0];
  if (!row) throw new NotAWorkspaceMemberError(userId, workspaceId);

  return {
    organizationId: row.organization_id,
    workspaceId,
    userId,
    scope: row.scope,
    teamIds: row.team_ids,
    permissions: new Set(row.permissions),
  };
}
