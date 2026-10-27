import { QUEUES, type DeliverJob, type IngestJob } from '@crm/contracts';
import { inboundEvents, systemContext, withRls } from '@crm/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { deliverMessage } from './deliver/process';
import type { WorkerDeps } from './deps';
import { processInboundEvent } from './ingest/process';
import { sweepStaleInboundEvents } from './maintenance/sweep';

export interface WorkerOptions {
  connection: ConnectionOptions;
  ingestConcurrency?: number;
  /** Период sweeper'а; 0 — не планировать (в тестах вызывается напрямую) */
  sweepEveryMs?: number;
}

/**
 * Поднимает обработчики очередей. Отдельная функция (а не main) — чтобы e2e-тесты запускали
 * настоящие BullMQ-воркеры в процессе теста.
 */
export async function startWorkers(deps: WorkerDeps, opts: WorkerOptions) {
  const ingest = new Worker<IngestJob>(QUEUES.ingest, async (job) => processInboundEvent(deps, job.data), {
    connection: opts.connection,
    concurrency: opts.ingestConcurrency ?? 10,
  });

  // Ретраи исчерпаны — фиксируем на событии, чтобы sweeper его больше не трогал, а оператор видел причину
  ingest.on('failed', async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    deps.log.error({ jobId: job.id, err: err.message }, 'ingest failed permanently');
    await withRls(deps.db, systemContext(job.data.organizationId, job.data.workspaceId), (tx) =>
      tx.update(inboundEvents).set({ status: 'failed', error: err.message, attempts: job.attemptsMade })
        .where(and(eq(inboundEvents.id, job.data.inboundEventId), eq(inboundEvents.status, 'received'))))
      .catch((e) => deps.log.error({ err: e }, 'failed to mark inbound event as failed'));
  });

  const deliver = new Worker<DeliverJob>(QUEUES.deliver, async (job) =>
    deliverMessage(deps, job.data, job.attemptsMade + 1 >= (job.opts.attempts ?? 1)), {
    connection: opts.connection,
    concurrency: 5,
  });

  const maintenance = new Worker(QUEUES.maintenance, async (job) => {
    if (job.name === 'sweep-inbound') return sweepStaleInboundEvents(deps);
  }, { connection: opts.connection, concurrency: 1 });

  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection: opts.connection });
  if (opts.sweepEveryMs !== 0) {
    // Scheduler с фиксированным id: несколько реплик воркера не размножат расписание
    await maintenanceQueue.upsertJobScheduler('sweep-inbound', { every: opts.sweepEveryMs ?? 60_000 }, { name: 'sweep-inbound' });
  }

  for (const w of [ingest, deliver, maintenance]) {
    w.on('error', (err) => deps.log.error({ err: err.message, queue: w.name }, 'worker error'));
  }

  return {
    async close() {
      await Promise.all([ingest.close(), deliver.close(), maintenance.close()]);
      await maintenanceQueue.close();
    },
  };
}
