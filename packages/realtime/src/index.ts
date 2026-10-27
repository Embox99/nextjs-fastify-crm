import type { ConversationDto, DealDto, LockHolder, MessageDto, ServerToClientEvents, Viewer } from '@crm/contracts';
import { rooms, rowRooms, type OwnedRow } from '@crm/domain';

type EventName = keyof ServerToClientEvents;
type EventArg<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

interface Broadcast {
  emit(event: string, ...args: unknown[]): unknown;
  except(room: string | string[]): Broadcast;
}

/**
 * Минимальный общий интерфейс Socket.io Server (API) и @socket.io/redis-emitter (воркер):
 * один и тот же publisher адресует события из процесса с сокетами и из процесса без них.
 */
export interface BroadcastTarget {
  to(room: string | string[]): Broadcast;
}

const conversationOwner = (c: Pick<ConversationDto, 'workspaceId' | 'assigneeId' | 'teamId'>): OwnedRow => ({
  workspaceId: c.workspaceId, ownerId: c.assigneeId, teamId: c.teamId,
});

export function createPublisher(target: BroadcastTarget) {
  const emit = <E extends EventName>(to: string[], event: E, payload: EventArg<E>, except?: string[]) => {
    const op = target.to(to);
    (except?.length ? op.except(except) : op).emit(event, payload);
  };

  return {
    /**
     * Событие уходит в объединение комнат «все / команда / владелец» — ровно тем, кто видит сделку.
     * Если сделку переназначили, прежние получатели, которые её больше не видят, получают deal.removed.
     */
    dealUpserted(change: { deal: DealDto; previous?: OwnedRow }, meta: { actorId: string | null; clientMutationId?: string }) {
      const to = rowRooms(change.deal);
      emit(to, 'deal.upserted', { deal: change.deal, ...meta });

      if (change.previous) {
        const lost = rowRooms(change.previous).filter((r) => !to.includes(r));
        if (lost.length) emit(lost, 'deal.removed', { dealId: change.deal.id }, to);
      }
    },

    /** Индикатор «редактирует X» нужен и на доске, и в открытой карточке */
    dealLock(deal: OwnedRow & { id: string }, lockedBy: LockHolder | null) {
      emit([...rowRooms(deal), rooms.deal(deal.workspaceId, deal.id)], 'deal.lock', { dealId: deal.id, lockedBy });
    },

    dealPresence(deal: { workspaceId: string; id: string }, viewers: Viewer[]) {
      emit([rooms.deal(deal.workspaceId, deal.id)], 'deal.presence', { dealId: deal.id, viewers });
    },

    /** Диалог адресуется так же, как сделка: ответственный, его команда, админы */
    conversationUpserted(conversation: ConversationDto) {
      emit(rowRooms(conversationOwner(conversation)), 'conversation.upserted', { conversation });
    },

    messageCreated(conversation: ConversationDto, message: MessageDto, clientMutationId?: string) {
      emit(rowRooms(conversationOwner(conversation)), 'message.created', { message, clientMutationId });
    },

    messageUpdated(conversation: Pick<ConversationDto, 'workspaceId' | 'assigneeId' | 'teamId'>, message: MessageDto) {
      emit(rowRooms(conversationOwner(conversation)), 'message.updated', { message });
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
