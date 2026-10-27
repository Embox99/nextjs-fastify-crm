import { domainEventJobId, type Actor, type DomainEvent, type DomainEventType } from '@crm/contracts';
import { sql } from 'drizzle-orm';
import type { WorkerDeps } from '../deps';

const BATCH = 200;

interface OutboxRow extends Record<string, unknown> {
  id: string | number;
  organization_id: string;
  workspace_id: string;
  type: string;
  deal_id: string | null;
  payload: unknown;
  actor: unknown;
  created_at: Date | string;
}

const toEvent = (r: OutboxRow): DomainEvent => ({
  id: Number(r.id),
  type: r.type as DomainEventType,
  organizationId: r.organization_id,
  workspaceId: r.workspace_id,
  dealId: r.deal_id,
  payload: r.payload as DomainEvent['payload'],
  actor: r.actor as Actor,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * Пачка outbox → очередь domain-events. Захват (published_at = now()) и постановка в очередь —
 * в одной транзакции: если addBulk упадёт, откат вернёт события в неопубликованные.
 * Если упадёт уже коммит — события уйдут повторно, но jobId = id события, и BullMQ дубль не создаст.
 */
export async function relayOutboxBatch(deps: WorkerDeps, limit = BATCH): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const rows = await tx.execute<OutboxRow>(sql`select * from app.claim_outbox(${limit})`);
    if (rows.length === 0) return 0;
    await deps.queues.domainEvents.addBulk(rows.map((r) => {
      const event = toEvent(r);
      return { name: event.type, data: event, opts: { jobId: domainEventJobId(event.id) } };
    }));
    return rows.length;
  });
}

/**
 * Цикл relay: полная пачка — сразу следующая (догоняем очередь), пустая — пауза.
 * Опрос раз в intervalMs дешёв (частичный индекс по published_at IS NULL); LISTEN/NOTIFY —
 * возможная оптимизация задержки, но не корректности.
 */
export function startRelay(deps: WorkerDeps, intervalMs = 250) {
  let stopped = false;
  let wake: (() => void) | undefined;

  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const n = await relayOutboxBatch(deps);
        failures = 0;
        if (n === BATCH) continue;
      } catch (err) {
        failures++;
        deps.log.error({ err: (err as Error).message }, 'outbox relay failed');
      }
      const pause = failures ? Math.min(intervalMs * 2 ** failures, 10_000) : intervalMs;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pause);
      });
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
