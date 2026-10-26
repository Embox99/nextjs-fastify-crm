import type { BoardDto, DealDto } from '@crm/contracts';
import { createDb, deals, type DbHandle } from '@crm/db';
import { columnDeals } from '@crm/domain';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, startReplica, type Replica } from './helpers';

let api: Replica;
let admin: DbHandle;
const demo = inject('demo');
let mutation = 0;
const mid = () => `m${++mutation}`;

beforeAll(async () => {
  api = await startReplica();
  admin = createDb(inject('adminUrl'), { max: 1 });
});

afterAll(async () => {
  await api?.close();
  await admin?.close();
});

const titlesIn = (board: BoardDto, stageId: string) => columnDeals(board.deals, stageId).map((d) => d.title);

describe('auth', () => {
  it('неверный пароль → 401, без токена → 401, чужой workspace → 403', async () => {
    const bad = await api.app.inject({
      method: 'POST', url: '/auth/login', payload: { organization: 'acme', email: 'rep1@acme.test', password: 'x' },
    });
    expect(bad.statusCode).toBe(401);

    expect((await api.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);

    const rep1 = await as(api.app, 'rep1');
    const foreign = await api.app.inject({
      method: 'GET', url: '/me',
      headers: { authorization: `Bearer ${rep1.token}`, 'x-workspace-id': '00000000-0000-4000-8000-000000000000' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('CORS preflight разрешает PATCH и заголовок workspace для origin фронтенда', async () => {
    const res = await api.app.inject({
      method: 'OPTIONS',
      url: '/deals/00000000-0000-4000-8000-000000000000',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type,x-workspace-id',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-headers']).toContain('x-workspace-id');
  });

  it('/me отдаёт scope и права роли', async () => {
    const lead = await as(api.app, 'lead');
    const me = await lead.get<{ scope: string; permissions: string[] }>('/me');
    expect(me.body.scope).toBe('team');
    expect(me.body.permissions).toContain('deal:reassign');
  });
});

describe('доска', () => {
  it('видимость повторяет RBAC: реп — свои, лид — команда, админ — всё', async () => {
    const [rep1, lead, admin] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'lead'), as(api.app, 'admin')]);
    const [b1, bl, ba] = await Promise.all([rep1.board(), lead.board(), admin.board()]);

    expect(b1.deals.length).toBeGreaterThan(0);
    expect(b1.deals.every((d) => d.ownerId === demo.users.rep1)).toBe(true);
    expect(bl.deals.every((d) => d.teamId === demo.teams.enterprise)).toBe(true);
    expect(bl.deals.some((d) => d.ownerId === demo.users.rep2)).toBe(true);
    expect(ba.deals.some((d) => d.teamId === demo.teams.smb)).toBe(true);
    expect(ba.stages.map((s) => s.name)).toEqual(['Новый', 'Квалификация', 'КП отправлено', 'Переговоры', 'Выиграно', 'Проиграно']);
    expect(ba.members).toHaveLength(5);
  });
});

describe('перемещение карточек', () => {
  it('новая сделка встаёт наверх колонки; перенос внутри колонки меняет только её ранг', async () => {
    const rep1 = await as(api.app, 'rep1');
    const a = await rep1.createDeal('move-A');
    const b = await rep1.createDeal('move-B');
    expect(a.ownerId).toBe(demo.users.rep1);
    expect(a.teamId).toBe(demo.teams.enterprise);

    let board = await rep1.board();
    const column = titlesIn(board, demo.stages.new);
    expect(column.slice(0, 2)).toEqual(['move-B', 'move-A']);

    // B — под A
    const moved = await rep1.post<DealDto>(`/deals/${b.id}/move`, {
      toStageId: demo.stages.new, beforeId: a.id, afterId: column[2] ? board.deals.find((d) => d.title === column[2])!.id : null,
      clientMutationId: mid(),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.version).toBe(b.version + 1);

    board = await rep1.board();
    expect(titlesIn(board, demo.stages.new).slice(0, 2)).toEqual(['move-A', 'move-B']);
    // ранг соседа не тронут — никаких UPDATE всей колонки
    expect(board.deals.find((d) => d.id === a.id)!.rank).toBe(a.rank);
  });

  it('перенос в другую колонку обновляет stageEnteredAt', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('move-stage');
    await new Promise((r) => setTimeout(r, 20));
    const res = await rep1.post<DealDto>(`/deals/${deal.id}/move`, {
      toStageId: demo.stages.qualified, beforeId: null, afterId: null, clientMutationId: mid(),
    });
    expect(res.status).toBe(200);
    expect(res.body.stageId).toBe(demo.stages.qualified);
    expect(Date.parse(res.body.stageEnteredAt)).toBeGreaterThan(Date.parse(deal.stageEnteredAt));
  });

  it('сосед из другой колонки (устаревшая доска) → 409', async () => {
    const rep1 = await as(api.app, 'rep1');
    const a = await rep1.createDeal('stale-A');
    const b = await rep1.createDeal('stale-B');
    const res = await rep1.post(`/deals/${a.id}/move`, {
      toStageId: demo.stages.proposal, beforeId: b.id, afterId: null, clientMutationId: mid(),
    });
    expect(res.status).toBe(409);
  });

  it('чужая сделка для репа не существует → 404', async () => {
    const [rep1, rep2] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'rep2')]);
    const foreign = await rep2.createDeal('foreign');
    const res = await rep1.post(`/deals/${foreign.id}/move`, {
      toStageId: demo.stages.qualified, beforeId: null, afterId: null, clientMutationId: mid(),
    });
    expect(res.status).toBe(404);
  });

  it('этап чужой воронки отклоняется составным FK → 422', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('fk');
    const res = await rep1.post(`/deals/${deal.id}/move`, {
      toStageId: '00000000-0000-4000-8000-000000000001', beforeId: null, afterId: null, clientMutationId: mid(),
    });
    expect(res.status).toBe(422);
  });

  it('одинаковые ранги соседей (гонка двух вставок) не ломают перемещение', async () => {
    const rep1 = await as(api.app, 'rep1');
    const [x, y, z] = [await rep1.createDeal('dup-X'), await rep1.createDeal('dup-Y'), await rep1.createDeal('dup-Z')];
    await admin.db.update(deals).set({ stageId: demo.stages.negotiation, rank: 'a5' }).where(inArray(deals.id, [x.id, y.id]));
    const [first, second] = [x, y].sort((p, q) => (p.id < q.id ? -1 : 1));

    const res = await rep1.post<DealDto>(`/deals/${z.id}/move`, {
      toStageId: demo.stages.negotiation, beforeId: first!.id, afterId: second!.id, clientMutationId: mid(),
    });
    expect(res.status).toBe(200);
    expect(res.body.rank > 'a5').toBe(true);   // встала сразу после группы одинаковых ключей

    const column = titlesIn(await rep1.board(), demo.stages.negotiation);
    expect(column.indexOf('dup-Z')).toBe(column.indexOf(second!.title) + 1);
  });

  it('валидация входа → 400', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('validation');
    const res = await rep1.post(`/deals/${deal.id}/move`, { toStageId: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('редактирование', () => {
  it('устаревшая версия → 409 с текущим состоянием', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('version');
    const first = await rep1.patch<DealDto>(`/deals/${deal.id}`, { version: deal.version, title: 'v2' });
    expect(first.status).toBe(200);

    const stale = await rep1.patch<{ current: DealDto }>(`/deals/${deal.id}`, { version: deal.version, title: 'lost update' });
    expect(stale.status).toBe(409);
    expect(stale.body.current.title).toBe('v2');
  });

  it('реп не может переназначать (нет deal:reassign), лид — может внутри команды', async () => {
    const [rep1, lead] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'lead')]);
    const deal = await rep1.createDeal('reassign');

    const byRep = await rep1.patch(`/deals/${deal.id}`, { version: deal.version, ownerId: demo.users.rep2 });
    expect(byRep.status).toBe(403);

    const byLead = await lead.patch<DealDto>(`/deals/${deal.id}`, { version: deal.version, ownerId: demo.users.rep2 });
    expect(byLead.status).toBe(200);
    expect(byLead.body.ownerId).toBe(demo.users.rep2);
  });

  it('лид не может увести сделку в чужую команду — RLS WITH CHECK → 403', async () => {
    const lead = await as(api.app, 'lead');
    const deal = await lead.createDeal('team-escape');
    const res = await lead.patch(`/deals/${deal.id}`, { version: deal.version, teamId: demo.teams.smb, ownerId: demo.users.rep3 });
    expect(res.status).toBe(403);

    const [row] = await admin.db.select().from(deals).where(eq(deals.id, deal.id));
    expect(row!.teamId).toBe(demo.teams.enterprise);
  });
});
