import type { DealDto } from '@crm/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, connect, emitAck, expectNoEvent, nextEvent, startReplica, type ClientSocket, type Replica } from './helpers';

// Две реплики API на одном Redis: события должны пересекать границу процесса
let a: Replica;
let b: Replica;
const sockets: ClientSocket[] = [];
const demo = inject('demo');

beforeAll(async () => {
  [a, b] = await Promise.all([startReplica(), startReplica()]);
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await Promise.all([a?.close(), b?.close()]);
});

async function socketFor(replica: Replica, user: 'admin' | 'lead' | 'rep1' | 'rep2' | 'rep3') {
  const client = await as(replica.app, user);
  const socket = await connect(replica.url, { token: client.token, workspaceId: client.workspaceId });
  sockets.push(socket);
  return { client, socket };
}

describe('real-time доставка между репликами', () => {
  it('перенос карточки видят только те, кому видна сделка', async () => {
    const rep1 = await socketFor(a, 'rep1');
    const lead = await socketFor(b, 'lead');
    const rep2 = await socketFor(a, 'rep2');
    const rep3 = await socketFor(b, 'rep3');

    const deal = await rep1.client.createDeal('rt-move');
    const leadGot = nextEvent(lead.socket, 'deal.upserted', (e) => e.deal.id === deal.id && e.clientMutationId === 'rt-1');
    const ownerGot = nextEvent(rep1.socket, 'deal.upserted', (e) => e.deal.id === deal.id && e.clientMutationId === 'rt-1');

    await rep1.client.post(`/deals/${deal.id}/move`, {
      toStageId: demo.stages.qualified, beforeId: null, afterId: null, clientMutationId: 'rt-1',
    });

    const event = await leadGot;                       // лид на другой реплике — через Redis-адаптер
    expect(event.deal.stageId).toBe(demo.stages.qualified);
    expect(event.actorId).toBe(demo.users.rep1);
    await ownerGot;                                    // эхо автору — клиент отфильтрует по clientMutationId

    await Promise.all([
      expectNoEvent(rep2.socket, 'deal.upserted', (e) => e.deal.id === deal.id),   // коллега по команде, но не владелец
      expectNoEvent(rep3.socket, 'deal.upserted', (e) => e.deal.id === deal.id),   // другая команда
    ]);
  });

  it('переназначение: прежний владелец получает deal.removed, новый — deal.upserted', async () => {
    const rep1 = await socketFor(a, 'rep1');
    const rep2 = await socketFor(b, 'rep2');
    const lead = await as(b.app, 'lead');

    const deal = await rep1.client.createDeal('rt-reassign');
    const removed = nextEvent(rep1.socket, 'deal.removed', (e) => e.dealId === deal.id);
    const appeared = nextEvent(rep2.socket, 'deal.upserted', (e) => e.deal.id === deal.id);

    const res = await lead.patch<DealDto>(`/deals/${deal.id}`, { version: deal.version, ownerId: demo.users.rep2 });
    expect(res.status).toBe(200);

    await removed;
    expect((await appeared).deal.ownerId).toBe(demo.users.rep2);
  });

  it('невалидный токен не подключается', async () => {
    await expect(connect(a.url, { token: 'garbage', workspaceId: demo.workspaceId })).rejects.toThrow(/unauthorized/);
  });
});

describe('presence и мягкие блокировки', () => {
  it('второй пользователь видит «редактирует X», блокировка снимается при отключении владельца', async () => {
    const rep1 = await socketFor(a, 'rep1');
    const lead = await socketFor(b, 'lead');
    const deal = await rep1.client.createDeal('rt-lock');

    const opened = await emitAck(rep1.socket, 'deal.open', { dealId: deal.id });
    expect(opened).toMatchObject({ ok: true, lockedBy: null });

    const leadSeesLock = nextEvent(lead.socket, 'deal.lock', (e) => e.dealId === deal.id && e.lockedBy !== null);
    const started = await emitAck(rep1.socket, 'deal.edit.start', { dealId: deal.id });
    expect(started).toMatchObject({ ok: true, acquired: true });
    // Лид ещё не открыл карточку, но индикатор на доске получает через комнату команды
    expect((await leadSeesLock).lockedBy?.name).toBe('Мария Петрова');

    const presence = nextEvent(rep1.socket, 'deal.presence', (e) => e.dealId === deal.id && e.viewers.length === 2);
    const leadOpened = await emitAck(lead.socket, 'deal.open', { dealId: deal.id });
    expect(leadOpened.ok && leadOpened.lockedBy?.userId).toBe(demo.users.rep1);
    expect((await presence).viewers.map((v) => v.name).sort()).toEqual(['Мария Петрова', 'Олег Лидов']);

    const contested = await emitAck(lead.socket, 'deal.edit.start', { dealId: deal.id });
    expect(contested).toMatchObject({ ok: true, acquired: false, lockedBy: { userId: demo.users.rep1 } });

    const released = nextEvent(lead.socket, 'deal.lock', (e) => e.dealId === deal.id && e.lockedBy === null);
    rep1.socket.disconnect();
    await released;

    const retaken = await emitAck(lead.socket, 'deal.edit.start', { dealId: deal.id });
    expect(retaken).toMatchObject({ ok: true, acquired: true });
  });

  it('открыть невидимую карточку нельзя', async () => {
    const rep3 = await socketFor(a, 'rep3');
    const rep1 = await as(a.app, 'rep1');
    const deal = await rep1.createDeal('rt-hidden');
    expect(await emitAck(rep3.socket, 'deal.open', { dealId: deal.id })).toEqual({ ok: false, error: 'not_found' });
  });
});
