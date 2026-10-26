import type { BoardDto, DealDto } from '@crm/contracts';
import { describe, expect, it } from 'vitest';
import { applyDealRemoval, applyDealUpsert, applyMove, columnDeals, neighboursAt } from '../src/board';
import { canSee, rowRooms, viewerRooms } from '../src/visibility';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WS = uuid(900);
const P = uuid(901);
const S1 = uuid(1);
const S2 = uuid(2);

const deal = (n: number, stageId: string, rank: string, extra: Partial<DealDto> = {}): DealDto => ({
  id: uuid(100 + n),
  workspaceId: WS,
  pipelineId: P,
  stageId,
  rank,
  title: `deal ${n}`,
  value: '0',
  currency: 'RUB',
  contactId: null,
  ownerId: null,
  teamId: null,
  stageEnteredAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  version: 1,
  ...extra,
});

const board = (deals: DealDto[]): BoardDto => ({
  pipeline: { id: P, name: 'Sales' },
  stages: [],
  deals,
  members: [],
});

const titles = (b: BoardDto, stageId: string) => columnDeals(b.deals, stageId).map((d) => d.title);

describe('neighboursAt + applyMove', () => {
  const b = board([deal(1, S1, 'a0'), deal(2, S1, 'a1'), deal(3, S1, 'a2'), deal(4, S2, 'a0')]);

  it('перемещение вниз внутри колонки', () => {
    const move = { toStageId: S1, ...neighboursAt(b.deals, uuid(101), S1, 2) };
    expect(move).toEqual({ toStageId: S1, beforeId: uuid(103), afterId: null });
    expect(titles(applyMove(b, uuid(101), move), S1)).toEqual(['deal 2', 'deal 3', 'deal 1']);
  });

  it('перемещение в начало другой колонки', () => {
    const move = { toStageId: S2, ...neighboursAt(b.deals, uuid(102), S2, 0) };
    const next = applyMove(b, uuid(102), move);
    expect(titles(next, S2)).toEqual(['deal 2', 'deal 4']);
    expect(titles(next, S1)).toEqual(['deal 1', 'deal 3']);
  });

  it('в пустую колонку', () => {
    const empty = uuid(3);
    const move = { toStageId: empty, ...neighboursAt(b.deals, uuid(101), empty, 5) };
    expect(move).toEqual({ toStageId: empty, beforeId: null, afterId: null });
    expect(titles(applyMove(b, uuid(101), move), empty)).toEqual(['deal 1']);
  });

  it('не мутирует исходную доску', () => {
    const snapshot = JSON.parse(JSON.stringify(b));
    applyMove(b, uuid(101), { toStageId: S2, beforeId: null, afterId: null });
    expect(b).toEqual(snapshot);
  });
});

describe('applyDealUpsert', () => {
  const b = board([deal(1, S1, 'a0', { version: 3 })]);

  it('старая версия не перетирает новую', () => {
    expect(applyDealUpsert(b, deal(1, S2, 'a0', { version: 2 }))).toBe(b);
  });

  it('новая версия применяется, новая сделка добавляется', () => {
    expect(applyDealUpsert(b, deal(1, S2, 'a0', { version: 4 })).deals[0]?.stageId).toBe(S2);
    expect(applyDealUpsert(b, deal(2, S1, 'a1')).deals).toHaveLength(2);
  });

  it('сделка из другой воронки удаляется с доски', () => {
    expect(applyDealUpsert(b, deal(1, S1, 'a0', { version: 4, pipelineId: uuid(999) })).deals).toEqual([]);
  });

  it('удаление', () => {
    expect(applyDealRemoval(b, uuid(101)).deals).toEqual([]);
  });
});

describe('visibility', () => {
  const T1 = uuid(501);
  const row = { workspaceId: WS, ownerId: uuid(1), teamId: T1 };

  it.each([
    [{ workspaceId: WS, userId: uuid(9), scope: 'all' as const, teamIds: [] }, true],
    [{ workspaceId: WS, userId: uuid(9), scope: 'team' as const, teamIds: [T1] }, true],
    [{ workspaceId: WS, userId: uuid(9), scope: 'team' as const, teamIds: [uuid(502)] }, false],
    [{ workspaceId: WS, userId: uuid(1), scope: 'own' as const, teamIds: [] }, true],
    [{ workspaceId: WS, userId: uuid(2), scope: 'own' as const, teamIds: [] }, false],
    [{ workspaceId: uuid(777), userId: uuid(1), scope: 'all' as const, teamIds: [] }, false],
  ])('canSee %#', (viewer, expected) => {
    expect(canSee(viewer, row)).toBe(expected);
  });

  it('комнаты зрителя пересекаются с комнатами строки тогда и только тогда, когда canSee', () => {
    const viewers = [
      { workspaceId: WS, userId: uuid(9), scope: 'all' as const, teamIds: [] },
      { workspaceId: WS, userId: uuid(9), scope: 'team' as const, teamIds: [T1] },
      { workspaceId: WS, userId: uuid(9), scope: 'team' as const, teamIds: [uuid(502)] },
      { workspaceId: WS, userId: uuid(1), scope: 'own' as const, teamIds: [] },
      { workspaceId: WS, userId: uuid(2), scope: 'own' as const, teamIds: [] },
    ];
    const rowR = new Set(rowRooms(row));
    for (const v of viewers) {
      expect(viewerRooms(v).some((r) => rowR.has(r))).toBe(canSee(v, row));
    }
  });
});
