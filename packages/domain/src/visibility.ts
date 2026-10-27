export type VisibilityScope = 'all' | 'team' | 'own';

export interface Viewer {
  workspaceId: string;
  userId: string | null;
  scope: VisibilityScope;
  teamIds: readonly string[];
}

export interface OwnedRow {
  workspaceId: string;
  ownerId: string | null;
  teamId: string | null;
}

/**
 * Зеркало RLS-политики deals_visibility (app.owner_visible) для мест, где SQL недоступен:
 * WS-шлюз решает, кому доставлять событие. Эквивалентность с RLS проверяется тестом в @crm/db.
 */
export function canSee(viewer: Viewer, row: OwnedRow): boolean {
  if (viewer.workspaceId !== row.workspaceId) return false;
  if (viewer.scope === 'all') return true;
  if (viewer.scope === 'team' && row.teamId !== null && viewer.teamIds.includes(row.teamId)) return true;
  return row.ownerId !== null && row.ownerId === viewer.userId;
}

/** Комнаты Socket.io повторяют модель видимости: событие строки уходит ровно тем, кто её видит. */
export const rooms = {
  /** Все сокеты workspace — только для событий без данных строк (например, «колонка перенумерована») */
  workspace: (workspaceId: string) => `ws:${workspaceId}`,
  workspaceAll: (workspaceId: string) => `ws:${workspaceId}:all`,
  team: (workspaceId: string, teamId: string) => `ws:${workspaceId}:team:${teamId}`,
  user: (workspaceId: string, userId: string) => `ws:${workspaceId}:user:${userId}`,
  deal: (workspaceId: string, dealId: string) => `ws:${workspaceId}:deal:${dealId}`,
};

/** Комнаты, в которые должен попасть сокет пользователя */
export function viewerRooms(viewer: Viewer): string[] {
  const result = [rooms.workspace(viewer.workspaceId)];
  if (viewer.userId) result.push(rooms.user(viewer.workspaceId, viewer.userId));
  if (viewer.scope === 'all') result.push(rooms.workspaceAll(viewer.workspaceId));
  if (viewer.scope === 'team') result.push(...viewer.teamIds.map((t) => rooms.team(viewer.workspaceId, t)));
  return result;
}

/** Комнаты, которым видна строка. Объединение — Socket.io доставит событие каждому сокету один раз. */
export function rowRooms(row: OwnedRow): string[] {
  const result = [rooms.workspaceAll(row.workspaceId)];
  if (row.teamId) result.push(rooms.team(row.workspaceId, row.teamId));
  if (row.ownerId) result.push(rooms.user(row.workspaceId, row.ownerId));
  return result;
}
