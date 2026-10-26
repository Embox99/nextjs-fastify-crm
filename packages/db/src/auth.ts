import { sql } from 'drizzle-orm';
import type { Db } from './client';

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  fullName: string;
}

/** null — неверная организация, email или пароль (намеренно неразличимо) */
export async function authenticate(
  db: Db,
  input: { organization: string; email: string; password: string },
): Promise<AuthenticatedUser | null> {
  const rows = await db.execute<{ user_id: string; organization_id: string; full_name: string }>(
    sql`select * from app.authenticate(${input.organization}, ${input.email}, ${input.password})`,
  );
  const row = rows[0];
  return row ? { userId: row.user_id, organizationId: row.organization_id, fullName: row.full_name } : null;
}

export async function listUserWorkspaces(db: Db, userId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`select * from app.user_workspaces(${userId})`);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
