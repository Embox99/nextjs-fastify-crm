import type { Action, ExecuteRunJob, NotificationDto } from '@crm/contracts';
import {
  activities, appendOutbox, automationRuns, conversations, deals, loadConversationDto, notifications,
  roles, systemContext, teamMembers, toDealDto, withRls, workspaceMembers, type Tx,
} from '@crm/db';
import { renderTemplate } from '@crm/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';
import { loadAutomationRow, parseAutomation, type DealRow } from './load';

/** Отложенные публикации: в Socket.io уходит только то, что уже закоммичено */
type AfterCommit = (() => void)[];

interface ActionContext {
  tx: Tx;
  run: typeof automationRuns.$inferSelect;
  deal: DealRow;
  after: AfterCommit;
  deps: WorkerDeps;
}

/**
 * Выполнение запуска. Действия идут строго по порядку (AssignManager до «уведомить ответственного»),
 * каждое — в своей транзакции вместе с инкрементом completed_actions. При ретрае после сбоя
 * выполненные действия пропускаются: эффекты в БД ровно один раз.
 */
export async function executeRun(deps: WorkerDeps, job: ExecuteRunJob): Promise<'succeeded' | 'skipped'> {
  const ctx = systemContext(job.organizationId, job.workspaceId);

  for (;;) {
    await reserveAssigneeIfNeeded(deps, ctx, job.runId);
    const after: AfterCommit = [];
    const step = await withRls(deps.db, ctx, async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, job.runId)).for('update');
      if (!run || run.status !== 'pending') return 'skipped' as const;

      const row = await loadAutomationRow(tx, run.automationId);
      const automation = row && parseAutomation(row);
      const [deal] = run.dealId ? await tx.select().from(deals).where(eq(deals.id, run.dealId)).for('update') : [];
      if (!automation || !deal) {
        await finish(tx, run.id, 'failed', !automation ? 'Automation is missing or invalid' : 'Deal not found');
        return 'skipped' as const;
      }

      const action = automation.actions[run.completedActions];
      if (!action) {
        await finish(tx, run.id, 'succeeded');
        return 'done' as const;
      }

      await runAction(action, { tx, run, deal, after, deps });
      await tx.update(automationRuns).set({ completedActions: run.completedActions + 1 }).where(eq(automationRuns.id, run.id));
      return 'next' as const;
    });

    for (const publish of after) publish();
    if (step === 'skipped') return 'skipped';
    if (step === 'done') return 'succeeded';
  }
}

async function finish(tx: Tx, runId: string, status: 'succeeded' | 'failed', error?: string) {
  await tx.update(automationRuns).set({ status, error: error ?? null, finishedAt: sql`now()` }).where(eq(automationRuns.id, runId));
}

export async function markRunFailed(deps: WorkerDeps, job: ExecuteRunJob, error: string) {
  await withRls(deps.db, systemContext(job.organizationId, job.workspaceId), (tx) =>
    tx.update(automationRuns).set({ status: 'failed', error, finishedAt: sql`now()` })
      .where(and(eq(automationRuns.id, job.runId), eq(automationRuns.status, 'pending'))));
}

function runAction(action: Action, c: ActionContext): Promise<void> {
  switch (action.type) {
    case 'AssignManager': return assignManager(c);
    case 'CreateTask': return createTask(c, action);
    case 'SendNotification': return sendNotification(c, action);
  }
}

/* ───────────── AssignManager ───────────── */

/**
 * Round-robin одним SQL-оператором. FOR UPDATE на строке пула сериализует только конкурентные
 * назначения в этот пул: два лида, распределяемые одновременно, не уйдут одному менеджеру.
 * Порядок — тот же, что у nextInRotation из @crm/domain.
 */
export async function pickNextAssignee(tx: Tx, poolId: string): Promise<{ userId: string; teamId: string } | null> {
  const rows = await tx.execute<{ user_id: string; team_id: string }>(sql`
    with pool as (
      select id, team_id, last_position from assignment_pools where id = ${poolId} for update
    ),
    next as (
      select m.user_id, m.position
      from assignment_pool_members m, pool p
      where m.pool_id = p.id and m.is_available
      order by (m.position <= p.last_position), m.position
      limit 1
    )
    update assignment_pools ap set last_position = next.position
    from next, pool
    where ap.id = pool.id
    returning next.user_id, pool.team_id`);
  const row = rows[0];
  return row ? { userId: row.user_id, teamId: row.team_id } : null;
}

/**
 * Резерв менеджера — отдельная короткая транзакция до основного шага. Горячая блокировка строки пула
 * держится только на выбор и запись в run.state, а не пока обновляются сделка, диалоги и outbox;
 * блокировка сделки при этом не берётся вовсе. Без этого разделения назначения выстраивались в
 * очередь на пуле, держа блокировки сделок, и вставали ingest повторных лидов (burst-тест: разбор
 * очереди 16,4 с → 5,7 с; без автоматизаций — 2,3 с, остаток — их собственная работа в той же БД).
 * На ретрае резерв уже есть — ротация не сдвигается второй раз.
 */
async function reserveAssigneeIfNeeded(deps: WorkerDeps, ctx: ReturnType<typeof systemContext>, runId: string) {
  await withRls(deps.db, ctx, async (tx) => {
    const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).for('update');
    if (!run || run.status !== 'pending' || !run.dealId) return;
    if (run.state.reservedAssignee?.actionIndex === run.completedActions) return;

    const row = await loadAutomationRow(tx, run.automationId);
    const action = row && parseAutomation(row)?.actions[run.completedActions];
    if (action?.type !== 'AssignManager') return;

    const [deal] = await tx.select({ ownerId: deals.ownerId }).from(deals).where(eq(deals.id, run.dealId));
    if (!deal || deal.ownerId) return;

    const next = await pickNextAssignee(tx, action.poolId);
    if (!next) {
      deps.log.warn({ poolId: action.poolId, runId }, 'assignment pool has no available members');
      return;
    }
    await tx.update(automationRuns)
      .set({ state: { ...run.state, reservedAssignee: { actionIndex: run.completedActions, ...next } } })
      .where(eq(automationRuns.id, runId));
  });
}

async function assignManager({ tx, run, deal, after, deps }: ActionContext) {
  // Уже назначенную сделку не перераспределяем: автоматизация не отбирает лид у менеджера
  if (deal.ownerId) return;
  const next = run.state.reservedAssignee?.actionIndex === run.completedActions ? run.state.reservedAssignee : null;
  if (!next) return;   // пул пуст — предупреждение уже записано при резерве

  const [updated] = await tx.update(deals)
    .set({ ownerId: next.userId, teamId: next.teamId, version: sql`${deals.version} + 1`, updatedAt: sql`now()` })
    .where(eq(deals.id, deal.id)).returning();
  // Диалоги сделки уходят тому же менеджеру — иначе он увидит сделку, но не переписку
  const convs = await tx.update(conversations)
    .set({ assigneeId: next.userId, teamId: next.teamId, updatedAt: sql`now()` })
    .where(eq(conversations.dealId, deal.id)).returning({ id: conversations.id });
  const convDtos = await Promise.all(convs.map((c) => loadConversationDto(tx, c.id)));

  await appendOutbox(tx, {
    organizationId: run.organizationId, workspaceId: run.workspaceId, type: 'deal.assigned', dealId: deal.id,
    payload: { ownerId: next.userId, previousOwnerId: deal.ownerId },
    actor: { kind: 'automation', automationId: run.automationId, depth: run.depth + 1 },
  });

  Object.assign(deal, updated);
  after.push(() => {
    deps.publisher.dealUpserted(
      { deal: toDealDto(updated!), previous: { workspaceId: deal.workspaceId, ownerId: null, teamId: null } },
      { actorId: null },
    );
    for (const dto of convDtos) if (dto) deps.publisher.conversationUpserted(dto);
  });
}

/* ───────────── Получатели ───────────── */

async function recipients(tx: Tx, deal: DealRow, to: 'owner' | 'teamLead' | 'admins'): Promise<string[]> {
  if (to === 'owner') return deal.ownerId ? [deal.ownerId] : [];
  if (to === 'teamLead') {
    if (!deal.teamId) return [];
    const leads = await tx.select({ userId: teamMembers.userId }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, deal.teamId), eq(teamMembers.isLead, true)));
    return leads.map((l) => l.userId);
  }
  const admins = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .innerJoin(roles, eq(roles.id, workspaceMembers.roleId))
    .where(and(eq(workspaceMembers.workspaceId, deal.workspaceId), eq(roles.scope, 'all')));
  return admins.map((a) => a.userId);
}

/* ───────────── CreateTask ───────────── */

async function createTask({ tx, deal }: ActionContext, action: Extract<Action, { type: 'CreateTask' }>) {
  // Ответственного нет (лид ещё не распределён) — задача на лида команды, иначе без исполнителя
  let [assignee] = await recipients(tx, deal, action.assignTo);
  if (!assignee && action.assignTo === 'owner') [assignee] = await recipients(tx, deal, 'teamLead');
  await tx.insert(activities).values({
    organizationId: deal.organizationId,
    workspaceId: deal.workspaceId,
    dealId: deal.id,
    contactId: deal.contactId,
    type: 'task',
    payload: { title: renderTemplate(action.title, deal) },
    assigneeId: assignee ?? null,
    dueAt: sql`now() + make_interval(mins => ${action.dueInMinutes})`,
  });
}

/* ───────────── SendNotification ───────────── */

async function sendNotification({ tx, run, deal, after, deps }: ActionContext, action: Extract<Action, { type: 'SendNotification' }>) {
  const userIds = await recipients(tx, deal, action.to);
  if (userIds.length === 0) return;

  const rows = await tx.insert(notifications).values(userIds.map((userId) => ({
    organizationId: deal.organizationId,
    workspaceId: deal.workspaceId,
    userId,
    title: renderTemplate(action.message, deal),
    body: deal.title,
    dealId: deal.id,
    automationRunId: run.id,
  }))).onConflictDoNothing().returning();

  after.push(() => {
    for (const n of rows) {
      const dto: NotificationDto = {
        id: n.id, title: n.title, body: n.body, dealId: n.dealId, readAt: null, createdAt: n.createdAt.toISOString(),
      };
      deps.publisher.notificationCreated(n.workspaceId, n.userId, dto);
    }
  });
}

