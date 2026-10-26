import type { ClientToServerEvents, DealDto, LockHolder, ServerToClientEvents, Viewer } from '@crm/contracts';
import { rooms, rowRooms, type OwnedRow } from '@crm/domain';
import type { Server } from 'socket.io';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;

export function createPublisher(io: IoServer) {
  return {
    /**
     * Событие уходит в объединение комнат «все / команда / владелец» — ровно тем, кто видит сделку.
     * Если сделку переназначили, прежние получатели, которые её больше не видят, получают deal.removed.
     */
    dealUpserted(change: { deal: DealDto; previous?: OwnedRow }, meta: { actorId: string | null; clientMutationId?: string }) {
      const target = rowRooms(change.deal);
      io.to(target).emit('deal.upserted', { deal: change.deal, ...meta });

      if (change.previous) {
        const lost = rowRooms(change.previous).filter((r) => !target.includes(r));
        if (lost.length) io.to(lost).except(target).emit('deal.removed', { dealId: change.deal.id });
      }
    },

    /** Индикатор «редактирует X» нужен и на доске, и в открытой карточке */
    dealLock(deal: OwnedRow & { id: string }, lockedBy: LockHolder | null) {
      io.to([...rowRooms(deal), rooms.deal(deal.workspaceId, deal.id)]).emit('deal.lock', { dealId: deal.id, lockedBy });
    },

    dealPresence(deal: { workspaceId: string; id: string }, viewers: Viewer[]) {
      io.to(rooms.deal(deal.workspaceId, deal.id)).emit('deal.presence', { dealId: deal.id, viewers });
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
