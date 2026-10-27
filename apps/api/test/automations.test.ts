import type { AutomationDto, DealDto, NotificationDto, TaskDto } from '@crm/contracts';
import { rebalanceJobId } from '@crm/contracts';
import { activities, createDb, deals, notifications, outboxEvents, type DbHandle } from '@crm/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, startReplica, type Replica } from './helpers';

const demo = inject('demo');
let api: Replica;
let admin: DbHandle;

beforeAll(async () => {
  api = await startReplica();
  admin = createDb(inject('adminUrl'), { max: 1 });
});

afterAll(async () => {
  await api?.close();
  await admin?.close();
});

describe('автоматизации', () => {
  it('настраивает только scope=all: реп получает 403, админ видит демо-набор', async () => {
    const [rep1, adm] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'admin')]);
    expect((await rep1.get('/automations')).status).toBe(403);
    const list = await adm.get<AutomationDto[]>('/automations');
    expect(list.body.map((a) => a.trigger.type).sort()).toEqual(['LeadCreated', 'NoActivityInDays', 'StageChanged', 'StageSlaBreached']);
  });

  it('создание, переключение, удаление; невалидное определение — 400, чужая ссылка — 422', async () => {
    const adm = await as(api.app, 'admin');
    const valid = {
      name: 'Тест', trigger: { type: 'StageChanged', toStageId: demo.stages.negotiation },
      conditions: { all: [{ field: 'deal.value', op: 'gte', value: 500000 }] },
      actions: [{ type: 'SendNotification', to: 'admins', message: 'Крупная сделка {{deal.title}}' }],
    };

    expect((await adm.post('/automations', { ...valid, conditions: { field: 'deal.value', op: 'regex', value: '.*' } })).status).toBe(400);
    expect((await adm.post('/automations', { ...valid, actions: [{ type: 'AssignManager', poolId: '00000000-0000-4000-8000-000000000000' }] })).status).toBe(422);
    expect((await adm.post('/automations', { ...valid, trigger: { type: 'StageChanged', toStageId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(422);

    const created = await adm.post<AutomationDto>('/automations', valid);
    expect(created.status).toBe(201);
    const toggled = await adm.patch<AutomationDto>(`/automations/${created.body.id}`, { enabled: false });
    expect(toggled.body).toMatchObject({ enabled: false, version: 2 });

    const del = await api.app.inject({
      method: 'DELETE', url: `/automations/${created.body.id}`,
      headers: { authorization: `Bearer ${adm.token}`, 'x-workspace-id': adm.workspaceId },
    });
    expect(del.statusCode).toBe(204);
  });

  it('пулы распределения с участниками', async () => {
    const adm = await as(api.app, 'admin');
    const pools = await adm.get<{ id: string; members: { fullName: string }[] }[]>('/assignment-pools');
    expect(pools.body[0]?.members.map((m) => m.fullName)).toEqual(['Мария Петрова', 'Иван Сидоров']);
  });
});

describe('outbox из API', () => {
  it('перенос в другой этап пишет deal.stage_changed с актором-пользователем в той же транзакции', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('outbox-move');
    await rep1.post(`/deals/${deal.id}/move`, { toStageId: demo.stages.qualified, beforeId: null, afterId: null, clientMutationId: 'o1' });

    const [event] = await admin.db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.dealId, deal.id), eq(outboxEvents.type, 'deal.stage_changed')));
    expect(event).toMatchObject({
      actor: { kind: 'user', id: demo.users.rep1 },
      payload: { fromStageId: demo.stages.new, toStageId: demo.stages.qualified },
      publishedAt: null,
    });
  });

  it('переназначение пишет deal.assigned; правка без смены владельца — нет', async () => {
    const [rep1, lead] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'lead')]);
    const deal = await rep1.createDeal('outbox-assign');
    const renamed = await rep1.patch<DealDto>(`/deals/${deal.id}`, { version: deal.version, title: 'новое имя' });
    await lead.patch(`/deals/${deal.id}`, { version: renamed.body.version, ownerId: demo.users.rep2 });

    const events = await admin.db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.dealId, deal.id), eq(outboxEvents.type, 'deal.assigned')));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ ownerId: demo.users.rep2, previousOwnerId: demo.users.rep1 });
  });

  it('длинный ключ после вставки ставит задачу ребаланса колонки', async () => {
    const rep1 = await as(api.app, 'rep1');
    const [a, b, c] = [await rep1.createDeal('rb-a'), await rep1.createDeal('rb-b'), await rep1.createDeal('rb-c')];
    await admin.db.update(deals).set({ stageId: demo.stages.won, rank: `a0${'V'.repeat(40)}` }).where(eq(deals.id, a.id));
    await admin.db.update(deals).set({ stageId: demo.stages.won, rank: `a0${'V'.repeat(40)}W` }).where(eq(deals.id, b.id));

    const res = await rep1.post<DealDto>(`/deals/${c.id}/move`, { toStageId: demo.stages.won, beforeId: a.id, afterId: b.id, clientMutationId: 'rb' });
    expect(res.status).toBe(200);
    expect(await api.app.queues.maintenance.getJob(rebalanceJobId(demo.stages.won))).toBeDefined();
  });
});

describe('уведомления и задачи', () => {
  it('каждый видит только свои уведомления; read-all обнуляет счётчик', async () => {
    const base = { organizationId: demo.organizationId, workspaceId: demo.workspaceId };
    await admin.db.insert(notifications).values([
      { ...base, userId: demo.users.rep1, title: 'для rep1' },
      { ...base, userId: demo.users.rep2, title: 'для rep2' },
    ]);
    const rep1 = await as(api.app, 'rep1');
    const before = await rep1.get<{ items: NotificationDto[]; unread: number }>('/notifications');
    expect(before.body.items.map((n) => n.title)).toContain('для rep1');
    expect(before.body.items.map((n) => n.title)).not.toContain('для rep2');
    expect(before.body.unread).toBeGreaterThan(0);

    await rep1.post('/notifications/read-all', {});
    expect((await rep1.get<{ unread: number }>('/notifications')).body.unread).toBe(0);
  });

  it('задачи сделки; выполнение задачи — активность по сделке', async () => {
    const rep1 = await as(api.app, 'rep1');
    const deal = await rep1.createDeal('с задачей');
    const [task] = await admin.db.insert(activities).values({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, dealId: deal.id, type: 'task',
      payload: { title: 'Позвонить' }, assigneeId: demo.users.rep1,
    }).returning();

    expect((await rep1.get<TaskDto[]>(`/deals/${deal.id}/tasks`)).body.map((t) => t.title)).toEqual(['Позвонить']);
    expect((await rep1.post(`/tasks/${task!.id}/complete`, {})).status).toBe(204);

    const [row] = await admin.db.select().from(deals).where(eq(deals.id, deal.id)).orderBy(desc(deals.updatedAt));
    expect(row!.lastActivityAt).not.toBeNull();
    const [done] = await admin.db.select().from(activities).where(eq(activities.id, task!.id));
    expect(done!.completedAt).not.toBeNull();
  });
});
