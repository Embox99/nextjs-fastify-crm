import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Длина ключа, после которой колонку стоит перенумеровать фоновой джобой */
export const RANK_REBALANCE_THRESHOLD = 32;

export class RankConflictError extends Error {
  constructor(readonly before: string | null, readonly after: string | null) {
    super(`Cannot place rank between ${before} and ${after}`);
  }
}

/**
 * Ключ строго между соседями. null — край колонки.
 * Порядок — побайтовый (collate "C" в Postgres совпадает с JS-сравнением строк).
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) throw new RankConflictError(before, after);
  return generateKeyBetween(before, after);
}

/** Ровные ключи для n карточек — для начального заполнения и ребаланса */
export const evenRanks = (n: number): string[] => generateNKeysBetween(null, null, n);

/** n упорядоченных ключей строго между соседями — вставка пачки (перенос сделок из удалённой колонки) */
export function ranksBetween(before: string | null, after: string | null, n: number): string[] {
  if (before !== null && after !== null && before >= after) throw new RankConflictError(before, after);
  return generateNKeysBetween(before, after, n);
}

export const needsRebalance = (rank: string) => rank.length > RANK_REBALANCE_THRESHOLD;

/** Порядок карточек в колонке: rank, затем id как детерминированный tie-breaker для одинаковых ключей */
export function compareByRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
