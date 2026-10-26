import type { BoardDto, DealDto, MoveDealInput } from '@crm/contracts';
import { compareByRank, rankBetween, RankConflictError } from './ranking';

/** Карточки колонки в порядке отображения */
export function columnDeals(deals: readonly DealDto[], stageId: string): DealDto[] {
  return deals.filter((d) => d.stageId === stageId).sort(compareByRank);
}

/**
 * Соседи для вставки карточки в колонку на позицию index (позиция считается в колонке
 * уже без перетаскиваемой карточки). Это ровно то, что клиент отправляет на сервер.
 */
export function neighboursAt(
  deals: readonly DealDto[],
  dealId: string,
  toStageId: string,
  index: number,
): Pick<MoveDealInput, 'beforeId' | 'afterId'> {
  const column = columnDeals(deals, toStageId).filter((d) => d.id !== dealId);
  const i = Math.max(0, Math.min(index, column.length));
  return { beforeId: column[i - 1]?.id ?? null, afterId: column[i]?.id ?? null };
}

/**
 * Оптимистичное перемещение на клиенте: тот же rankBetween, что и на сервере.
 * Если локально ключ не вычислить (одинаковые ранги у соседей), карточка встаёт сразу
 * после верхнего соседа, а точный ключ придёт в ответе сервера.
 */
export function applyMove(board: BoardDto, dealId: string, move: Pick<MoveDealInput, 'toStageId' | 'beforeId' | 'afterId'>): BoardDto {
  const byId = new Map(board.deals.map((d) => [d.id, d]));
  const deal = byId.get(dealId);
  if (!deal) return board;

  const before = move.beforeId ? byId.get(move.beforeId)?.rank ?? null : null;
  const after = move.afterId ? byId.get(move.afterId)?.rank ?? null : null;

  let rank: string;
  try {
    rank = rankBetween(before, after);
  } catch (e) {
    if (!(e instanceof RankConflictError)) throw e;
    rank = before ?? deal.rank;
  }

  return {
    ...board,
    deals: board.deals.map((d) => (d.id === dealId ? { ...d, stageId: move.toStageId, rank } : d)),
  };
}

/**
 * Применение серверного события. Версия защищает от переупорядоченных доставок:
 * более старое событие не перетирает более новое состояние.
 */
export function applyDealUpsert(board: BoardDto, incoming: DealDto): BoardDto {
  if (incoming.pipelineId !== board.pipeline.id) return applyDealRemoval(board, incoming.id);

  const current = board.deals.find((d) => d.id === incoming.id);
  if (current && current.version > incoming.version) return board;

  return {
    ...board,
    deals: current
      ? board.deals.map((d) => (d.id === incoming.id ? incoming : d))
      : [...board.deals, incoming],
  };
}

export function applyDealRemoval(board: BoardDto, dealId: string): BoardDto {
  return board.deals.some((d) => d.id === dealId)
    ? { ...board, deals: board.deals.filter((d) => d.id !== dealId) }
    : board;
}
