import type { Actor, DomainEvent, DomainEventPayloads, DomainEventType } from '@crm/contracts';
import type { Tx } from './client';
import { outboxEvents } from './schema';

/**
 * Записать доменное событие в outbox. Вызывается внутри той же транзакции, что и изменение:
 * откат изменения откатывает и событие, коммит гарантирует, что событие не потеряется.
 */
export async function appendOutbox<T extends DomainEventType>(tx: Tx, event: {
  organizationId: string;
  workspaceId: string;
  type: T;
  dealId: string | null;
  payload: DomainEventPayloads[T];
  actor: Actor;
}): Promise<void> {
  await tx.insert(outboxEvents).values(event);
}

export const toDomainEvent = (row: typeof outboxEvents.$inferSelect): DomainEvent => ({
  id: row.id,
  type: row.type as DomainEventType,
  organizationId: row.organizationId,
  workspaceId: row.workspaceId,
  dealId: row.dealId,
  payload: row.payload as DomainEvent['payload'],
  actor: row.actor as Actor,
  createdAt: row.createdAt.toISOString(),
});
