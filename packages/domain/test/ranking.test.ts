import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareByRank, evenRanks, needsRebalance, rankBetween, RankConflictError } from '../src/ranking';

describe('rankBetween', () => {
  it('ключ всегда строго между соседями при любой последовательности вставок', () => {
    fc.assert(fc.property(fc.array(fc.nat(), { maxLength: 300 }), (positions) => {
      const keys = [rankBetween(null, null)];
      for (const p of positions) {
        const i = p % (keys.length + 1);
        keys.splice(i, 0, rankBetween(keys[i - 1] ?? null, keys[i] ?? null));
      }
      for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
    }));
  });

  it('вставка в край и между ровными ключами', () => {
    const [a, b] = evenRanks(2) as [string, string];
    expect(rankBetween(null, a) < a).toBe(true);
    expect(rankBetween(b, null) > b).toBe(true);
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });

  it('устаревшие или одинаковые соседи → RankConflictError', () => {
    expect(() => rankBetween('a2', 'a1')).toThrow(RankConflictError);
    expect(() => rankBetween('a1', 'a1')).toThrow(RankConflictError);
  });

  it('многократная вставка в одну точку удлиняет ключ и детектируется needsRebalance', () => {
    let lo = 'a0';
    const hi = 'a1';
    let iterations = 0;
    while (!needsRebalance(lo) && iterations < 1_000) {
      lo = rankBetween(lo, hi);
      iterations++;
    }
    expect(needsRebalance(lo)).toBe(true);
    expect(iterations).toBeGreaterThan(20);   // ребаланс нужен редко
  });

  it('evenRanks возвращает отсортированные уникальные ключи', () => {
    const keys = evenRanks(100);
    expect(new Set(keys).size).toBe(100);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('compareByRank', () => {
  it('одинаковые ранги упорядочиваются по id детерминированно', () => {
    const cards = [
      { id: 'b', rank: 'a0' },
      { id: 'a', rank: 'a0' },
      { id: 'c', rank: 'Zz' },
    ];
    expect([...cards].sort(compareByRank).map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });
});
