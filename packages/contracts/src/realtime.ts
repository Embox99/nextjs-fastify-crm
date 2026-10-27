import type { DealDto } from './board';
import type { NotificationDto } from './automations';
import type { ConversationDto, MessageDto } from './inbox';

export interface LockHolder {
  userId: string;
  name: string;
  socketId: string;
  /** epoch ms — когда блокировка истечёт без heartbeat */
  expiresAt: number;
}

export interface Viewer {
  userId: string;
  name: string;
}

export interface DealUpsertedEvent {
  deal: DealDto;
  actorId: string | null;
  clientMutationId?: string;
}

export interface DealLockEvent {
  dealId: string;
  lockedBy: LockHolder | null;
}

export interface DealPresenceEvent {
  dealId: string;
  viewers: Viewer[];
}

export type Ack<T> = (res: { ok: true } & T | { ok: false; error: string }) => void;

export interface ServerToClientEvents {
  'deal.upserted': (e: DealUpsertedEvent) => void;
  /** Сделка удалена или перестала быть видимой получателю (переназначение) */
  'deal.removed': (e: { dealId: string }) => void;
  'deal.lock': (e: DealLockEvent) => void;
  'deal.presence': (e: DealPresenceEvent) => void;
  'conversation.upserted': (e: { conversation: ConversationDto }) => void;
  'message.created': (e: { message: MessageDto; clientMutationId?: string }) => void;
  /** Смена статуса доставки исходящего сообщения */
  'message.updated': (e: { message: MessageDto }) => void;
  'notification.created': (e: { notification: NotificationDto }) => void;
  /** Ключи колонки перенумерованы — клиент перезапрашивает доску */
  'stage.rebalanced': (e: { pipelineId: string; stageId: string }) => void;
}

export interface ClientToServerEvents {
  'deal.open': (e: { dealId: string }, ack: Ack<{ viewers: Viewer[]; lockedBy: LockHolder | null }>) => void;
  'deal.close': (e: { dealId: string }) => void;
  'deal.edit.start': (e: { dealId: string }, ack: Ack<{ acquired: boolean; lockedBy: LockHolder }>) => void;
  'deal.edit.heartbeat': (e: { dealId: string }) => void;
  'deal.edit.stop': (e: { dealId: string }) => void;
}

/** Период heartbeat и TTL мягкой блокировки — общие для клиента и сервера */
export const LOCK_TTL_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;
