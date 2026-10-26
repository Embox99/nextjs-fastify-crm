import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { authenticate, listUserWorkspaces } from '../src/auth';
import { createDb, type DbHandle } from '../src/client';
import { users } from '../src/schema';
import { DEMO_ORG, DEMO_PASSWORD, seedDemo, type DemoSeed } from '../src/seed/demo';

let admin: DbHandle;
let app: DbHandle;
let demo: DemoSeed;

beforeAll(async () => {
  admin = createDb(inject('adminUrl'), { max: 1 });
  app = createDb(inject('appUrl'), { max: 2 });
  demo = await seedDemo(admin.db);
});

afterAll(async () => {
  await Promise.all([admin?.close(), app?.close()]);
});

describe('authenticate', () => {
  it('верный пароль → пользователь', async () => {
    const user = await authenticate(app.db, { organization: DEMO_ORG, email: 'REP1@acme.test', password: DEMO_PASSWORD });
    expect(user?.userId).toBe(demo.users.rep1);
  });

  it.each([
    ['неверный пароль', { organization: DEMO_ORG, email: 'rep1@acme.test', password: 'nope' }],
    ['неизвестный email', { organization: DEMO_ORG, email: 'ghost@acme.test', password: DEMO_PASSWORD }],
    ['чужая организация', { organization: 'other', email: 'rep1@acme.test', password: DEMO_PASSWORD }],
  ])('%s → null', async (_, input) => {
    expect(await authenticate(app.db, input)).toBeNull();
  });

  it('список workspace пользователя', async () => {
    expect(await listUserWorkspaces(app.db, demo.users.rep1)).toEqual([{ id: demo.workspaceId, name: 'Москва' }]);
  });

  it('seedDemo идемпотентен', async () => {
    expect(await seedDemo(admin.db)).toEqual(demo);
  });
});

describe('хеш пароля', () => {
  it('роль приложения не может прочитать password_hash даже через select *', async () => {
    const err = await app.db.select().from(users).then(() => null, (e) => e.cause ?? e);
    expect(err?.message).toMatch(/permission denied/);
    const ok = await app.db.select({ id: users.id }).from(users);
    expect(ok).toEqual([]);   // без RLS-контекста — пусто, но сам запрос разрешён
  });

  it('и не может его перезаписать', async () => {
    const err = await app.db.execute(sql`update users set password_hash = 'x'`).then(() => null, (e) => e.cause ?? e);
    expect(err?.message).toMatch(/permission denied/);
  });
});
