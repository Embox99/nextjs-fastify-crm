import { domainEventJobId, slaJobId, type DomainEvent } from '@crm/contracts';
import {
  activities, appendOutbox, assignmentPools, automationRuns, automations, conversations, deals, notifications,
  outboxEvents, systemContext, toDomainEvent, withRls,
} from '@crm/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { executeRun } from '../src/automations/executor';
import { handleDomainEvent } from '../src/automations/matcher';
import { relayOutboxBatch } from '../src/automations/relay';
import { handleSlaCheck, scheduleSlaCheck } from '../src/automations/sla';
import { scanStaleDeals } from '../src/automations/stale-scan';
import { processInboundEvent } from '../src/ingest/process';
import { rebalanceStage } from '../src/maintenance/rebalance';
import { insertEvent, makeDeps, randomPhone, uniq, type TestDeps } from './helpers';

const demo = inject('demo');
let deps: TestDeps;
const sys = () => systemContext(demo.organizationId, demo.workspaceId);

beforeAll(() => {
  deps = makeDeps();
});

afterAll(async () => {
  await deps?.close();
});

/** Все неопубликованные события забираются, чтобы тесты не видели хвосты друг друга */
beforeEach(async () => {
  await deps.admin.db.update(outboxEvents).set({ publishedAt: sql`now()` }).where(isNull(outboxEvents.publishedAt));
});

async function lastEvent(type: string, dealId?: string): Promise<DomainEvent> {
  const [row] = await deps.admin.db.select().from(outboxEvents)
    .where(and(eq(outboxEvents.type, type), dealId ? eq(outboxEvents.dealId, dealId) : undefined))
    .orderBy(desc(outboxEvents.id)).limit(1);
  return toDomainEvent(row!);
}

/** Лид с сайта → сделка → событие lead.created → запуск автоматизаций → выполнение */
async function leadThroughAutomations() {
  await processInboundEvent(deps, await insertEvent(deps, 'website', { name: uniq('Лид'), phone: randomPhone(), message: 'Привет' }));
  const event = await lastEvent('lead.created');
  const runIds = await handleDomainEvent(deps, event);
  for (const runId of runIds) await executeRun(deps, { runId, organizationId: demo.organizationId, workspaceId: demo.workspaceId });
  const [deal] = await deps.admin.db.select().from(deals).where(eq(deals.id, event.dealId!));
  return { event, runIds, deal: deal! };
}

async function resetPool() {
  await deps.admin.db.update(assignmentPools).set({ lastPosition: -1 }).where(eq(assignmentPools.id, demo.assignmentPool));
}

describe('outbox relay', () => {
  it('забирает событие в очередь с jobId = id события и больше его не отдаёт', async () => {
    await withRls(deps.db, sys(), (tx) => appendOutbox(tx, {
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, type: 'deal.created', dealId: null, payload: {}, actor: { kind: 'system' },
    }));
    const event = await lastEvent('deal.created');

    expect(await relayOutboxBatch(deps)).toBe(1);
    expect((await deps.queues.domainEvents.getJob(domainEventJobId(event.id)))?.data).toMatchObject({ id: event.id, type: 'deal.created' });
    expect(await relayOutboxBatch(deps)).toBe(0);
  });

  it('сбой постановки в очередь откатывает захват — событие уйдёт со следующей пачкой', async () => {
    await withRls(deps.db, sys(), (tx) => appendOutbox(tx, {
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, type: 'deal.created', dealId: null, payload: {}, actor: { kind: 'system' },
    }));
    const broken = { ...deps, queues: { ...deps.queues, domainEvents: { addBulk: () => Promise.reject(new Error('redis down')) } as any } };

    await expect(relayOutboxBatch(broken)).rejects.toThrow('redis down');
    expect(await relayOutboxBatch(deps)).toBe(1);
  });
});

describe('LeadCreated → AssignManager (round-robin) → уведомление', () => {
  beforeEach(resetPool);

  it('лид назначается по кругу; диалог уходит тому же менеджеру; менеджер получает уведомление', async () => {
    const first = await leadThroughAutomations();
    const second = await leadThroughAutomations();
    const third = await leadThroughAutomations();

    expect([first.deal.ownerId, second.deal.ownerId, third.deal.ownerId]).toEqual([demo.users.rep1, demo.users.rep2, demo.users.rep1]);
    expect(first.deal.teamId).toBe(demo.teams.enterprise);

    const [conv] = await deps.admin.db.select().from(conversations).where(eq(conversations.dealId, first.deal.id));
    expect(conv).toMatchObject({ assigneeId: demo.users.rep1, teamId: demo.teams.enterprise });

    const [note] = await deps.admin.db.select().from(notifications).where(eq(notifications.dealId, first.deal.id));
    expect(note).toMatchObject({ userId: demo.users.rep1, title: `Вам назначен новый лид: ${first.deal.title}` });

    // Менеджер узнаёт обо всём в своей комнате: сделка, диалог, уведомление
    const toRep1 = deps.emitted.filter((e) => e.rooms.includes(`ws:${demo.workspaceId}:user:${demo.users.rep1}`));
    expect(toRep1.some((e) => e.event === 'deal.upserted' && e.payload.deal.id === first.deal.id)).toBe(true);
    expect(toRep1.some((e) => e.event === 'notification.created' && e.payload.notification.dealId === first.deal.id)).toBe(true);

    // Назначение — само доменное событие, с актором-автоматизацией и depth + 1
    const assigned = await lastEvent('deal.assigned', first.deal.id);
    expect(assigned.actor).toMatchObject({ kind: 'automation', depth: 1 });
  });

  it('20 лидов параллельно — ровно 10/10, без двойных назначений', async () => {
    const jobs = await Promise.all(Array.from({ length: 20 }, () =>
      insertEvent(deps, 'website', { name: uniq('Параллельно'), phone: randomPhone() })));
    await Promise.all(jobs.map((j) => processInboundEvent(deps, j)));

    const events = (await deps.admin.db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.type, 'lead.created'), isNull(outboxEvents.publishedAt)))).map(toDomainEvent);
    expect(events).toHaveLength(20);
    const runIds = (await Promise.all(events.map((e) => handleDomainEvent(deps, e)))).flat();
    await Promise.all(runIds.map((runId) => executeRun(deps, { runId, organizationId: demo.organizationId, workspaceId: demo.workspaceId })));

    const owners = await deps.admin.db.select({ ownerId: deals.ownerId }).from(deals)
      .where(inArray(deals.id, events.map((e) => e.dealId!)));
    const counts = owners.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.ownerId!]: (acc[d.ownerId!] ?? 0) + 1 }), {});
    expect(counts).toEqual({ [demo.users.rep1]: 10, [demo.users.rep2]: 10 });
  });

  it('повторная доставка события и повторный запуск ничего не дублируют', async () => {
    const { event, runIds } = await leadThroughAutomations();
    expect(await handleDomainEvent(deps, event)).toEqual([]);
    expect(await executeRun(deps, { runId: runIds[0]!, organizationId: demo.organizationId, workspaceId: demo.workspaceId })).toBe('skipped');
    expect(await deps.admin.db.select().from(notifications).where(eq(notifications.dealId, event.dealId!))).toHaveLength(1);
  });

  it('ретрай после частичного выполнения продолжает со следующего действия', async () => {
    await processInboundEvent(deps, await insertEvent(deps, 'website', { name: uniq('Ретрай'), phone: randomPhone() }));
    const event = await lastEvent('lead.created');
    const [runId] = await handleDomainEvent(deps, event);
    // Будто AssignManager уже выполнен, а процесс упал перед уведомлением
    await deps.admin.db.update(automationRuns).set({ completedActions: 1 }).where(eq(automationRuns.id, runId!));
    const [poolBefore] = await deps.admin.db.select().from(assignmentPools).where(eq(assignmentPools.id, demo.assignmentPool));

    await executeRun(deps, { runId: runId!, organizationId: demo.organizationId, workspaceId: demo.workspaceId });

    const [poolAfter] = await deps.admin.db.select().from(assignmentPools).where(eq(assignmentPools.id, demo.assignmentPool));
    expect(poolAfter!.lastPosition).toBe(poolBefore!.lastPosition);   // ротация не сдвинулась второй раз
    const [run] = await deps.admin.db.select().from(automationRuns).where(eq(automationRuns.id, runId!));
    expect(run).toMatchObject({ status: 'succeeded', completedActions: 2 });
  });

  it('событие с превышенной глубиной цепочки игнорируется', async () => {
    const event = { ...(await lastEvent('lead.created')), id: 999_999_999, actor: { kind: 'automation' as const, automationId: 'x', depth: 5 } };
    expect(await handleDomainEvent(deps, event)).toEqual([]);
  });
});

describe('StageChanged + условие deal.value > 100 000', () => {
  async function moveToProposal(value: string) {
    const dealId = await withRls(deps.db, sys(), async (tx) => {
      const [deal] = await tx.insert(deals).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, pipelineId: demo.pipelineId,
        stageId: demo.stages.proposal, rank: 'zz', title: uniq('КП'), value, ownerId: demo.users.rep1, teamId: demo.teams.enterprise,
      }).returning();
      await appendOutbox(tx, {
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, type: 'deal.stage_changed', dealId: deal!.id,
        payload: { fromStageId: demo.stages.qualified, toStageId: demo.stages.proposal, stageEnteredAt: deal!.stageEnteredAt.toISOString() },
        actor: { kind: 'user', id: demo.users.rep1 },
      });
      return deal!.id;
    });
    const runIds = await handleDomainEvent(deps, await lastEvent('deal.stage_changed', dealId));
    for (const runId of runIds) await executeRun(deps, { runId, organizationId: demo.organizationId, workspaceId: demo.workspaceId });
    return { dealId, runIds };
  }

  it('крупная сделка — задача владельцу и уведомление лиду; мелкая — ничего', async () => {
    const big = await moveToProposal('150000');
    expect(big.runIds).toHaveLength(1);
    const [task] = await deps.admin.db.select().from(activities).where(and(eq(activities.dealId, big.dealId), eq(activities.type, 'task')));
    expect(task).toMatchObject({ assigneeId: demo.users.rep1 });
    expect((task!.payload as { title: string }).title).toMatch(/^Перезвонить по КП:/);
    expect(task!.dueAt!.getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    const [note] = await deps.admin.db.select().from(notifications).where(eq(notifications.dealId, big.dealId));
    expect(note).toMatchObject({ userId: demo.users.lead });
    expect(note!.title).toContain('150 000 ₽');

    expect((await moveToProposal('50000')).runIds).toEqual([]);
  });
});

describe('SLA', () => {
  it('вход в этап с SLA планирует отложенную проверку с ключом пребывания в этапе', async () => {
    const { deal } = await leadThroughAutomations();
    const event = await lastEvent('lead.created', deal.id);
    await scheduleSlaCheck(deps, event);
    const job = await deps.queues.automations.getJob(slaJobId(deal.id, demo.stages.new, deal.stageEnteredAt.toISOString()));
    expect(job?.opts.delay).toBeGreaterThan(14 * 60_000);
  });

  it('сделка всё ещё в этапе → deal.sla_breached; ушла или вернулась позже → таймер устарел', async () => {
    const { deal } = await leadThroughAutomations();
    const job = {
      dealId: deal.id, stageId: demo.stages.new, stageEnteredAt: deal.stageEnteredAt.toISOString(), slaMinutes: 15,
      organizationId: demo.organizationId, workspaceId: demo.workspaceId,
    };
    expect(await handleSlaCheck(deps, { ...job, stageEnteredAt: new Date(0).toISOString() })).toBe(false);
    expect(await handleSlaCheck(deps, job)).toBe(true);

    // Нарушение запускает демо-автоматизацию: уведомление лиду и срочная задача ответственному
    const runIds = await handleDomainEvent(deps, await lastEvent('deal.sla_breached', deal.id));
    for (const runId of runIds) await executeRun(deps, { runId, organizationId: demo.organizationId, workspaceId: demo.workspaceId });
    const notes = await deps.admin.db.select().from(notifications).where(eq(notifications.dealId, deal.id));
    expect(notes.map((n) => n.userId)).toContain(demo.users.lead);
    const tasks = await deps.admin.db.select().from(activities).where(and(eq(activities.dealId, deal.id), eq(activities.type, 'task')));
    expect(tasks[0]?.assigneeId).toBe(deal.ownerId);
  });
});

describe('NoActivityInDays', () => {
  it('сканер запускает автоматизацию для залежавшихся сделок — раз в сутки', async () => {
    const { deal } = await leadThroughAutomations();
    await deps.admin.db.update(deals).set({ lastActivityAt: sql`now() - interval '10 days'` }).where(eq(deals.id, deal.id));

    expect(await scanStaleDeals(deps)).toBeGreaterThanOrEqual(1);
    const [run] = await deps.admin.db.select().from(automationRuns)
      .where(and(eq(automationRuns.dealId, deal.id), sql`${automationRuns.eventKey} like 'stale-%'`));
    expect(run).toBeDefined();

    const again = await scanStaleDeals(deps);
    const runs = await deps.admin.db.select().from(automationRuns)
      .where(and(eq(automationRuns.dealId, deal.id), sql`${automationRuns.eventKey} like 'stale-%'`));
    expect(runs).toHaveLength(1);
    expect(again).toBe(0);
  });

  it('выключенная автоматизация не запускается', async () => {
    await deps.admin.db.update(automations).set({ enabled: false }).where(eq(automations.triggerType, 'NoActivityInDays'));
    try {
      expect(await scanStaleDeals(deps)).toBe(0);
    } finally {
      await deps.admin.db.update(automations).set({ enabled: true }).where(eq(automations.triggerType, 'NoActivityInDays'));
    }
  });
});

describe('ребаланс колонки', () => {
  it('длинные ключи заменяются ровными, порядок сохраняется, клиенты получают stage.rebalanced', async () => {
    const stageId = demo.stages.lost;
    const long = ['a0' + 'V'.repeat(40), 'a0' + 'V'.repeat(41), 'a0' + 'W'.repeat(40)];
    const ids = await withRls(deps.db, sys(), async (tx) => (await tx.insert(deals).values(long.map((rank, i) => ({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, pipelineId: demo.pipelineId,
      stageId, rank, title: `rebalance-${i}`,
    }))).returning({ id: deals.id })).map((r) => r.id));

    const orderBefore = (await deps.admin.db.select({ id: deals.id }).from(deals).where(eq(deals.stageId, stageId))
      .orderBy(deals.rank, deals.id)).map((r) => r.id);
    await rebalanceStage(deps, { stageId, pipelineId: demo.pipelineId, organizationId: demo.organizationId, workspaceId: demo.workspaceId });

    const after = await deps.admin.db.select({ id: deals.id, rank: deals.rank }).from(deals).where(eq(deals.stageId, stageId))
      .orderBy(deals.rank, deals.id);
    expect(after.map((r) => r.id)).toEqual(orderBefore);
    expect(after.every((r) => r.rank.length <= 3)).toBe(true);
    expect(ids.every((id) => after.some((r) => r.id === id))).toBe(true);
    expect(deps.emitted.some((e) => e.event === 'stage.rebalanced' && e.payload.stageId === stageId)).toBe(true);
  });
});
