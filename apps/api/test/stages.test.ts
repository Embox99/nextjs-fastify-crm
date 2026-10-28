import type { BoardDto, StageDto } from '@crm/contracts';
import {
  automations, createDb, loadAuthContext, outboxEvents, pipelineStages, pipelines, withRls, type DbHandle,
} from '@crm/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { as, startReplica, type Replica } from './helpers';

const demo = inject('demo');
let api: Replica;
let admin: DbHandle;

beforeAll(async () => {
  api = await startReplica();
  admin = createDb(inject('adminUrl'), { max: 1 });
});

/** Колонки и автоматизации, созданные здесь, не должны протекать в другие файлы (они проверяют демо-набор) */
const createdStages: string[] = [];
const createdAutomations: string[] = [];

afterAll(async () => {
  if (createdAutomations.length) await admin.db.delete(automations).where(inArray(automations.id, createdAutomations));
  if (createdStages.length) await admin.db.delete(pipelineStages).where(inArray(pipelineStages.id, createdStages));
  await api?.close();
  await admin?.close();
});

const del = async (who: Awaited<ReturnType<typeof as>>, stageId: string, query = '') => {
  const res = await api.app.inject({
    method: 'DELETE', url: `/stages/${stageId}${query}`,
    headers: { authorization: `Bearer ${who.token}`, 'x-workspace-id': who.workspaceId },
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

const stageNames = (board: BoardDto) => board.stages.map((s) => s.name);

describe('колонки воронки', () => {
  it('по умолчанию новая колонка встаёт после последней открытой — перед «Выиграно»', async () => {
    const adm = await as(api.app, 'admin');
    const res = await adm.post<StageDto>(`/pipelines/${demo.pipelineId}/stages`, { name: 'Демо назначено', slaMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.slaMinutes).toBe(60);
    createdStages.push(res.body.id);

    const names = stageNames(await adm.board());
    expect(names.indexOf('Демо назначено')).toBe(names.indexOf('Won') - 1);
    expect(names.indexOf('Демо назначено')).toBeGreaterThan(names.indexOf('Negotiation'));
  });

  it('вставка после указанной колонки, переименование, перестановка', async () => {
    const adm = await as(api.app, 'admin');
    const created = await adm.post<StageDto>(`/pipelines/${demo.pipelineId}/stages`, { name: 'Бриф', afterStageId: demo.stages.new });
    expect(stageNames(await adm.board()).slice(0, 2)).toEqual(['New', 'Бриф']);

    const renamed = await adm.patch<StageDto>(`/stages/${created.body.id}`, { name: 'Бриф получен', slaMinutes: null });
    expect(renamed.body).toMatchObject({ name: 'Бриф получен', slaMinutes: null });

    // В самое начало: перед «Новый»
    const moved = await adm.post<StageDto>(`/stages/${created.body.id}/move`, { beforeId: null, afterId: demo.stages.new });
    expect(moved.status).toBe(200);
    expect(stageNames(await adm.board()).slice(0, 2)).toEqual(['Бриф получен', 'New']);

    expect((await del(adm, created.body.id)).status).toBe(204);
  });

  it('управлять колонками может только администратор — и в API, и в RLS', async () => {
    const lead = await as(api.app, 'lead');
    expect((await lead.post(`/pipelines/${demo.pipelineId}/stages`, { name: 'x' })).status).toBe(403);
    expect((await lead.patch(`/stages/${demo.stages.new}`, { name: 'x' })).status).toBe(403);
    expect((await del(lead, demo.stages.new)).status).toBe(403);
  });

  it('непустую колонку без moveDealsTo не удалить; с ним — сделки переезжают в конец целевой', async () => {
    const [adm, rep1] = await Promise.all([as(api.app, 'admin'), as(api.app, 'rep1')]);
    const stage = (await adm.post<StageDto>(`/pipelines/${demo.pipelineId}/stages`, { name: 'Временная' })).body;
    const a = await rep1.createDeal('уедет-1');
    const b = await rep1.createDeal('уедет-2');
    for (const d of [a, b]) {
      await rep1.post(`/deals/${d.id}/move`, { toStageId: stage.id, beforeId: null, afterId: null, clientMutationId: d.id });
    }

    const blocked = await del(adm, stage.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ dealCount: 2 });

    expect((await del(adm, stage.id, `?moveDealsTo=${demo.stages.qualified}`)).status).toBe(204);

    const board = await rep1.board();
    expect(board.stages.some((s) => s.id === stage.id)).toBe(false);
    const column = board.deals.filter((d) => d.stageId === demo.stages.qualified).sort((x, y) => (x.rank < y.rank ? -1 : 1));
    expect(column.slice(-2).map((d) => d.title).sort()).toEqual(['уедет-1', 'уедет-2']);

    // Перенос — настоящая смена этапа: событие для автоматизаций и SLA
    const events = await admin.db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.dealId, a.id), eq(outboxEvents.type, 'deal.stage_changed')));
    expect(events.map((e) => (e.payload as { toStageId: string }).toStageId)).toContain(demo.stages.qualified);
  });

  it('колонку, на которую ссылается автоматизация, удалить нельзя', async () => {
    const adm = await as(api.app, 'admin');
    const res = await del(adm, demo.stages.proposal, `?moveDealsTo=${demo.stages.qualified}`);
    expect(res.status).toBe(409);
    expect(res.body.automations).toContain('Large deal: proposal sent');
  });

  it('последнюю открытую колонку удалить нельзя — входящим лидам некуда было бы попадать', async () => {
    const adm = await as(api.app, 'admin');
    // Отдельная воронка из одной колонки
    const [pipeline] = await admin.db.insert(pipelines)
      .values({ organizationId: demo.organizationId, workspaceId: demo.workspaceId, name: 'Мини' }).returning();
    const [only] = await admin.db.insert(pipelineStages).values({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, pipelineId: pipeline!.id, name: 'Единственная', rank: 'a0',
    }).returning();
    expect((await del(adm, only!.id)).status).toBe(422);
    await admin.db.delete(pipelineStages).where(eq(pipelineStages.id, only!.id));
    await admin.db.delete(pipelines).where(eq(pipelines.id, pipeline!.id));
  });

  it('ссылка из условия автоматизации тоже блокирует удаление', async () => {
    const adm = await as(api.app, 'admin');
    const stage = (await adm.post<StageDto>(`/pipelines/${demo.pipelineId}/stages`, { name: 'В условии' })).body;
    createdStages.push(stage.id);
    const [automation] = await admin.db.insert(automations).values({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, name: 'Ссылается в условии',
      trigger: { type: 'LeadCreated' }, triggerType: 'LeadCreated',
      conditions: { all: [{ field: 'deal.stageId', op: 'eq', value: stage.id }] },
      actions: [{ type: 'SendNotification', to: 'admins', message: 'x' }],
    }).returning({ id: automations.id });
    createdAutomations.push(automation!.id);
    const res = await del(adm, stage.id);
    expect(res.status).toBe(409);
    expect(res.body.automations).toEqual(['Ссылается в условии']);
  });
});

describe('RLS на этапы', () => {
  it('лид не может вставить колонку в обход API', async () => {
    const app = createDb(inject('appUrl'), { max: 1 });
    try {
      const ctx = await loadAuthContext(app.db, demo.users.lead, demo.workspaceId);
      const err = await withRls(app.db, ctx, (tx) => tx.insert(pipelineStages).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, pipelineId: demo.pipelineId, name: 'обход', rank: 'zz',
      })).then(() => null, (e) => e.cause ?? e);
      expect(err?.message).toMatch(/row-level security/);
      // Читать колонки лиду можно
      const rows = await withRls(app.db, ctx, (tx) => tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, demo.pipelineId)));
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

