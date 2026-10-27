import type { CreateDealInput, DealDto, MoveDealInput, UpdateDealInput } from '@crm/contracts';
import { appendOutbox, deals, pipelineStages, teamMembers, toDealDto, type AuthContext, type Tx } from '@crm/db';
import { needsRebalance, rankBetween, RankConflictError, type OwnedRow } from '@crm/domain';
import { and, asc, eq, gt, inArray, min, sql } from 'drizzle-orm';
import { ConflictError } from '../../plugins/errors';

export interface DealChange {
  deal: DealDto;
  /** Владелец/команда до изменения — чтобы снять карточку у тех, кто перестал её видеть */
  previous?: OwnedRow;
}

export class NotFoundError extends Error {}

const tenant = (auth: AuthContext) => ({ organizationId: auth.organizationId, workspaceId: auth.workspaceId });
const user = (auth: AuthContext) => ({ kind: 'user' as const, id: auth.userId });

const owned = (d: { workspaceId: string; ownerId: string | null; teamId: string | null }): OwnedRow => ({
  workspaceId: d.workspaceId, ownerId: d.ownerId, teamId: d.teamId,
});

export async function createDeal(tx: Tx, auth: AuthContext, input: CreateDealInput): Promise<DealChange> {
  const [stage] = await tx.select({ id: pipelineStages.id }).from(pipelineStages)
    .where(input.stageId
      ? and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.pipelineId, input.pipelineId))
      : and(eq(pipelineStages.pipelineId, input.pipelineId), eq(pipelineStages.kind, 'open')))
    .orderBy(asc(pipelineStages.rank))
    .limit(1);
  if (!stage) throw new NotFoundError('stage');

  // Менеджер по умолчанию создаёт сделку на себя; команда — команда владельца
  const ownerId = input.ownerId !== undefined ? input.ownerId : auth.scope === 'own' ? auth.userId : null;
  const teamId = input.teamId !== undefined ? input.teamId : await ownerTeam(tx, ownerId ?? auth.userId);

  // Новые карточки — наверх колонки
  const [top] = await tx.select({ rank: min(deals.rank) }).from(deals).where(eq(deals.stageId, stage.id));

  const [row] = await tx.insert(deals).values({
    organizationId: auth.organizationId,
    workspaceId: auth.workspaceId,
    pipelineId: input.pipelineId,
    stageId: stage.id,
    rank: rankBetween(null, top?.rank ?? null),
    title: input.title,
    value: input.value,
    ownerId,
    teamId,
  }).returning();
  await appendOutbox(tx, { ...tenant(auth), type: 'deal.created', dealId: row!.id, payload: {}, actor: user(auth) });
  return { deal: toDealDto(row!) };
}

export async function updateDeal(tx: Tx, auth: AuthContext, id: string, input: UpdateDealInput): Promise<DealChange> {
  const prev = await lockDeal(tx, id);
  // Optimistic concurrency: правка поверх чужой несохранённой версии — конфликт, а не тихая перезапись
  if (prev.version !== input.version) throw new ConflictError('Deal was modified by someone else', toDealDto(prev));

  const [row] = await tx.update(deals).set({
    ...(input.title !== undefined && { title: input.title }),
    ...(input.value !== undefined && { value: input.value }),
    ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
    ...(input.teamId !== undefined && { teamId: input.teamId }),
    version: sql`${deals.version} + 1`,
    updatedAt: sql`now()`,
  }).where(eq(deals.id, id)).returning();

  if (row!.ownerId !== prev.ownerId) {
    await appendOutbox(tx, {
      ...tenant(auth), type: 'deal.assigned', dealId: id,
      payload: { ownerId: row!.ownerId, previousOwnerId: prev.ownerId }, actor: user(auth),
    });
  }
  return { deal: toDealDto(row!), previous: owned(prev) };
}

/**
 * Перемещение карточки. Клиент присылает id соседей, а не готовый ключ: ранги соседей
 * читаются здесь, в транзакции, поэтому клиент с устаревшим состоянием не испортит порядок.
 */
export async function moveDeal(tx: Tx, auth: AuthContext, id: string, input: MoveDealInput): Promise<DealChange & { rebalance: boolean }> {
  const neighbourIds = [input.beforeId, input.afterId].filter((x): x is string => x !== null);
  const neighbours = neighbourIds.length
    ? await tx.select({ id: deals.id, rank: deals.rank, stageId: deals.stageId }).from(deals)
      .where(inArray(deals.id, neighbourIds))
    : [];

  const before = input.beforeId ? neighbours.find((n) => n.id === input.beforeId) : undefined;
  const after = input.afterId ? neighbours.find((n) => n.id === input.afterId) : undefined;
  // Сосед пропал (удалён / стал невидим) или уехал в другую колонку — клиент видит устаревшую доску
  if ((input.beforeId && !before) || (input.afterId && !after)) throw new RankConflictError(null, null);
  if ([before, after].some((n) => n && n.stageId !== input.toStageId)) throw new RankConflictError(null, null);

  const rank = await rankForGap(tx, input.toStageId, before?.rank ?? null, after?.rank ?? null);
  const prev = await lockDeal(tx, id);
  const stageChanged = prev.stageId !== input.toStageId;

  const [row] = await tx.update(deals).set({
    stageId: input.toStageId,
    rank,
    version: sql`${deals.version} + 1`,
    updatedAt: sql`now()`,
    ...(stageChanged && { stageEnteredAt: sql`now()` }),
  }).where(eq(deals.id, id)).returning();

  // Событие для движка автоматизаций — в той же транзакции (transactional outbox)
  if (stageChanged) {
    await appendOutbox(tx, {
      ...tenant(auth), type: 'deal.stage_changed', dealId: id,
      payload: { fromStageId: prev.stageId, toStageId: input.toStageId, stageEnteredAt: row!.stageEnteredAt.toISOString() },
      actor: user(auth),
    });
  }
  return { deal: toDealDto(row!), rebalance: needsRebalance(rank) };
}

/**
 * Одинаковые ранги у соседей возможны: два клиента одновременно вставили карточку в одну щель
 * и получили один и тот же ключ (порядок между ними держит tie-breaker по id). Вставить строго
 * между равными ключами нельзя — ставим карточку сразу после группы одинаковых.
 */
async function rankForGap(tx: Tx, stageId: string, before: string | null, after: string | null): Promise<string> {
  if (before === null || after === null || before < after) return rankBetween(before, after);
  if (before > after) throw new RankConflictError(before, after);

  const [next] = await tx.select({ rank: min(deals.rank) }).from(deals)
    .where(and(eq(deals.stageId, stageId), gt(deals.rank, before)));
  return rankBetween(before, next?.rank ?? null);
}

async function lockDeal(tx: Tx, id: string) {
  const [row] = await tx.select().from(deals).where(eq(deals.id, id)).for('no key update');
  if (!row) throw new NotFoundError('deal');   // невидима под RLS == не существует
  return row;
}

async function ownerTeam(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ teamId: teamMembers.teamId }).from(teamMembers)
    .where(eq(teamMembers.userId, userId)).limit(1);
  return row?.teamId ?? null;
}
