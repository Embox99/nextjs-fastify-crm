import { canSee } from '@crm/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { auditLogs } from '../src/audit';
import { NotAWorkspaceMemberError } from '../src/auth-context';
import { createDb, type Db, type DbHandle, type Tx } from '../src/client';
import { activities, contacts, deals } from '../src/schema';
import { withRls, type RlsContext } from '../src/with-rls';
import { seedRbacFixture, type RbacFixture } from './fixture';

let admin: DbHandle;
let app: DbHandle;
let f: RbacFixture;

beforeAll(async () => {
  admin = createDb(inject('adminUrl'), { max: 2 });
  app = createDb(inject('appUrl'), { max: 4 });
  f = await seedRbacFixture(admin.db, app.db);
});

afterAll(async () => {
  await Promise.all([admin?.close(), app?.close()]);
});

class Rollback extends Error {}

/** Выполняет fn под RLS и откатывает транзакцию — мутационные тесты не влияют друг на друга. */
async function inRolledBackTx<T>(ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result!: T;
  await withRls(app.db, ctx, async (tx) => {
    result = await fn(tx);
    throw new Rollback();
  }).catch((e) => {
    if (!(e instanceof Rollback)) throw e;
  });
  return result;
}

/** drizzle оборачивает ошибку драйвера в DrizzleQueryError — смотрим на исходную ошибку Postgres. */
async function pgError(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const pg = (e as { cause?: unknown }).cause ?? e;
    return pg as { code: string; message: string };
  }
  throw new Error('expected query to fail');
}

const visibleDeals = async (who: string, ws?: string) => {
  const rows = await withRls(app.db, await f.ctx(who, ws), (tx) => tx.select({ id: deals.id }).from(deals));
  return rows.map((r) => f.label(r.id)).sort();
};

describe('AuthContext', () => {
  it('лид получает свои команды вместе с подкомандами', async () => {
    const ctx = await f.ctx('L1');
    expect(ctx.scope).toBe('team');
    expect([...ctx.teamIds].sort()).toEqual([f.id('T1'), f.id('T1a')].sort());
  });

  it('организация берётся из membership, права роли подгружаются', async () => {
    const ctx = await f.ctx('R1');
    expect(ctx.organizationId).toBe(f.id('A'));
    expect(ctx.scope).toBe('own');
    expect(ctx.teamIds).toEqual([]);
    expect(ctx.permissions.has('deal:update')).toBe(true);
    expect(ctx.permissions.has('deal:reassign')).toBe(false);
  });

  it('не участник workspace не получает контекст', async () => {
    await expect(f.ctx('R1', 'W2')).rejects.toBeInstanceOf(NotAWorkspaceMemberError);
    await expect(f.ctx('B_ADM', 'W1')).rejects.toBeInstanceOf(NotAWorkspaceMemberError);
  });
});

describe('RLS: видимость сделок', () => {
  it.each([
    { who: 'ADM', ws: 'W1', sees: ['dR1', 'dR2', 'dR3', 'dR4', 'dU'] },
    { who: 'ADM', ws: 'W2', sees: ['dW2'] },                       // другой workspace той же организации
    { who: 'L1', ws: 'W1', sees: ['dR1', 'dR2', 'dR4', 'dU'] },    // T1 + подкоманда T1a, без T2
    { who: 'R1', ws: 'W1', sees: ['dR1'] },
    { who: 'R3', ws: 'W1', sees: ['dR3'] },
    { who: 'B_ADM', ws: 'WB', sees: ['dB'] },                      // чужая организация изолирована
  ])('$who в $ws видит ровно $sees', async ({ who, ws, sees }) => {
    expect(await visibleDeals(who, ws)).toEqual([...sees].sort());
  });

  it('canSee() из @crm/domain (используется WS-шлюзом) эквивалентен RLS для всех пар пользователь × сделка', async () => {
    const all = await admin.db.select().from(deals).where(eq(deals.workspaceId, f.id('W1')));
    for (const who of ['ADM', 'L1', 'R1', 'R2', 'R3', 'R4']) {
      const ctx = await f.ctx(who);
      const viaRls = new Set((await withRls(app.db, ctx, (tx) => tx.select({ id: deals.id }).from(deals))).map((r) => r.id));
      for (const d of all) {
        expect(canSee(ctx, d), `${who} × ${f.label(d.id)}`).toBe(viaRls.has(d.id));
      }
    }
  });

  it('без контекста (забыли withRls) не видно ничего', async () => {
    expect(await app.db.select().from(deals)).toEqual([]);
    expect(await app.db.select().from(contacts)).toEqual([]);
  });

  it('подмена scope в контексте без membership не расширяет доступ за пределы организации', async () => {
    const forged: RlsContext = { ...(await f.ctx('R1')), scope: 'all', workspaceId: f.id('WB') };
    const rows = await withRls(app.db, forged, (tx) => tx.select().from(deals));
    expect(rows).toEqual([]);   // org A + workspace из org B не совпадают ни с одной строкой
  });
});

describe('RLS: запись сделок', () => {
  it('реп не может переназначить свою сделку на коллегу', async () => {
    const err = await pgError(inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.update(deals).set({ ownerId: f.id('R2') }).where(eq(deals.id, f.id('dR1')))));
    expect(err.message).toMatch(/row-level security/);
  });

  it('реп не может обновить чужую сделку — 0 строк, существование не раскрывается', async () => {
    const rows = await inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.update(deals).set({ title: 'hacked' }).where(eq(deals.id, f.id('dR2'))).returning());
    expect(rows).toEqual([]);
  });

  it('реп обновляет свою сделку', async () => {
    const rows = await inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.update(deals).set({ title: 'renamed' }).where(eq(deals.id, f.id('dR1'))).returning());
    expect(rows).toHaveLength(1);
  });

  it('лид переназначает сделку внутри команды, но не может увести её в чужую команду', async () => {
    const ctx = await f.ctx('L1');
    const moved = await inRolledBackTx(ctx, (tx) =>
      tx.update(deals).set({ ownerId: f.id('R2') }).where(eq(deals.id, f.id('dR1'))).returning());
    expect(moved).toHaveLength(1);

    const err = await pgError(inRolledBackTx(ctx, (tx) =>
      tx.update(deals).set({ teamId: f.id('T2'), ownerId: f.id('R3') }).where(eq(deals.id, f.id('dR1')))));
    expect(err.message).toMatch(/row-level security/);
  });

  it('реп не может создать сделку на другого владельца', async () => {
    const err = await pgError(inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.insert(deals).values(newDeal({ ownerId: f.id('R2') }))));
    expect(err.message).toMatch(/row-level security/);
  });

  it('реп не может вставить строку в чужой workspace', async () => {
    const err = await pgError(inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.insert(deals).values(newDeal({ ownerId: f.id('R1'), workspaceId: f.id('W2') }))));
    expect(err.message).toMatch(/row-level security/);
  });

  it('составной FK не даёт сослаться на контакт чужой организации', async () => {
    const err = await pgError(inRolledBackTx(await f.ctx('R1'), (tx) =>
      tx.insert(deals).values(newDeal({ ownerId: f.id('R1'), contactId: f.id('cB') }))));
    expect(err.code).toBe('23503');   // foreign_key_violation
  });

  function newDeal(overrides: Partial<typeof deals.$inferInsert>): typeof deals.$inferInsert {
    return {
      organizationId: f.id('A'),
      workspaceId: f.id('W1'),
      pipelineId: f.id('W1:pipeline'),
      stageId: f.id('W1:stage'),
      rank: 'a1',
      title: 'new',
      teamId: f.id('T1'),
      ...overrides,
    };
  }
});

describe('RLS: производные сущности', () => {
  it('контакты: свои + привязанные к видимым сделкам', async () => {
    const rows = await withRls(app.db, await f.ctx('R1'), (tx) => tx.select({ id: contacts.id }).from(contacts));
    expect(rows.map((r) => f.label(r.id)).sort()).toEqual(['cOwnR1', 'cR1']);
  });

  it('активности наследуют видимость сделки', async () => {
    await admin.db.insert(activities).values([
      { organizationId: f.id('A'), workspaceId: f.id('W1'), dealId: f.id('dR1'), type: 'note', payload: { text: 'r1' } },
      { organizationId: f.id('A'), workspaceId: f.id('W1'), dealId: f.id('dR2'), type: 'note', payload: { text: 'r2' } },
    ]);
    const rows = await withRls(app.db, await f.ctx('R1'), (tx) => tx.select().from(activities));
    expect(rows.map((r) => f.label(r.dealId!))).toEqual(['dR1']);
  });
});

describe('Audit log', () => {
  it('изменение пишется триггером с автором из контекста; читать может только scope=all', async () => {
    await withRls(app.db, await f.ctx('R2'), (tx) =>
      tx.update(deals).set({ value: '150000.00' }).where(eq(deals.id, f.id('dR2'))));

    const [entry] = await admin.db.select().from(auditLogs)
      .where(and(eq(auditLogs.entityId, f.id('dR2')), eq(auditLogs.action, 'update')));
    expect(entry?.actorId).toBe(f.id('R2'));
    expect(entry?.diff).toEqual({ value: [0, 150000] });   // numeric -> jsonb number без потери точности

    const asRep = await withRls(app.db, await f.ctx('R2'), (tx) => tx.select().from(auditLogs));
    expect(asRep).toEqual([]);
    const asAdmin = await withRls(app.db, await f.ctx('ADM'), (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.entityId, f.id('dR2'))));
    expect(asAdmin.length).toBeGreaterThan(0);
  });

  it('приложение не может править или удалять аудит', async () => {
    const ctx = await f.ctx('ADM');
    expect((await pgError(withRls(app.db, ctx, (tx) => tx.delete(auditLogs)))).message).toMatch(/permission denied/);
    expect((await pgError(withRls(app.db, ctx, (tx) => tx.execute(sql`select * from audit_logs_default`)))).message)
      .toMatch(/permission denied/);
  });
});

describe('Защита от регресса схемы', () => {
  it('каждая таблица с organization_id под ENABLE + FORCE RLS и имеет политику', async () => {
    const rows = await admin.db.execute<{ table: string; rls: boolean; forced: boolean; policies: number }>(sql`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`);

    const unprotected = rows
      .filter((r) => !r.rls || !r.forced || (r.policies === 0 && r.table !== 'audit_logs_default'))
      .map((r) => r.table);
    expect(unprotected).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(14);
  });

  it('у роли приложения нет BYPASSRLS', async () => {
    const rows = await admin.db.execute<{ rolname: string }>(sql`
      select rolname from pg_roles where rolname in ('crm_app', 'crm_app_user') and (rolbypassrls or rolsuper)`);
    expect(rows).toEqual([]);
  });

  it('функции-предикаты RLS инлайнятся в план, а не вызываются на каждую строку', async () => {
    const rows = await withRls(app.db, await f.ctx('L1'), (tx) =>
      tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain (costs off) select * from deals where pipeline_id = ${f.id('W1:pipeline')}`));
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');

    // Неинлайненная функция видна в плане по имени и вызывается на каждую строку
    expect(plan, plan).not.toMatch(/in_workspace|owner_visible/);
    expect(plan, plan).toMatch(/current_setting/);
  });
});
