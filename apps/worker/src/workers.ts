import { QUEUES, type DeliverJob, type DomainEvent, type ExecuteRunJob, type IngestJob, type RebalanceJob, type SlaCheckJob } from '@crm/contracts';
import { inboundEvents, systemContext, withRls } from '@crm/db';
import * as Sentry from '@sentry/node';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { executeRun, markRunFailed } from './automations/executor';
import { handleDomainEvent } from './automations/matcher';
import { startRelay } from './automations/relay';
import { handleSlaCheck } from './automations/sla';
import { scanStaleDeals } from './automations/stale-scan';
import { deliverMessage } from './deliver/process';
import type { WorkerDeps } from './deps';
import { processInboundEvent } from './ingest/process';
import { rebalanceStage } from './maintenance/rebalance';
import { sweepStaleInboundEvents } from './maintenance/sweep';

export interface WorkerOptions {
  connection: ConnectionOptions;
  ingestConcurrency?: number;
  /** Периоды планировщиков; 0 — не планировать (в тестах функции вызываются напрямую) */
  sweepEveryMs?: number;
  staleScanEveryMs?: number;
  /** Период опроса outbox; 0 — relay не запускать */
  relayIntervalMs?: number;
}

const isLastAttempt = (job: Job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
const exhausted = (job: Job | undefined): job is Job => Boolean(job && job.attemptsMade >= (job.opts.attempts ?? 1));

/**
 * Поднимает обработчики очередей и relay outbox. Отдельная функция (а не main) — чтобы e2e-тесты
 * запускали настоящие BullMQ-воркеры в процессе теста.
 */
export async function startWorkers(deps: WorkerDeps, opts: WorkerOptions) {
  const { connection } = opts;

  const ingest = new Worker<IngestJob>(QUEUES.ingest, async (job) => processInboundEvent(deps, job.data), {
    connection, concurrency: opts.ingestConcurrency ?? 10,
  });
  // Ретраи исчерпаны — фиксируем на событии, чтобы sweeper его больше не трогал, а оператор видел причину
  ingest.on('failed', async (job, err) => {
    if (!exhausted(job)) return;
    deps.log.error({ jobId: job.id, err: err.message }, 'ingest failed permanently');
    await withRls(deps.db, systemContext(job.data.organizationId, job.data.workspaceId), (tx) =>
      tx.update(inboundEvents).set({ status: 'failed', error: err.message, attempts: job.attemptsMade })
        .where(and(eq(inboundEvents.id, job.data.inboundEventId), eq(inboundEvents.status, 'received'))))
      .catch((e) => deps.log.error({ err: e }, 'failed to mark inbound event as failed'));
  });

  const deliver = new Worker<DeliverJob>(QUEUES.deliver, async (job) => deliverMessage(deps, job.data, isLastAttempt(job)), {
    connection, concurrency: 5,
  });

  const domainEvents = new Worker<DomainEvent>(QUEUES.domainEvents, async (job) => handleDomainEvent(deps, job.data), {
    connection, concurrency: 10,
  });

  const automations = new Worker(QUEUES.automations, async (job) => {
    switch (job.name) {
      case 'execute-run': return executeRun(deps, job.data as ExecuteRunJob);
      case 'sla-check': return handleSlaCheck(deps, job.data as SlaCheckJob);
      case 'stale-scan': return scanStaleDeals(deps);
    }
  }, { connection, concurrency: 10 });
  automations.on('failed', async (job, err) => {
    if (job?.name !== 'execute-run' || !exhausted(job)) return;
    deps.log.error({ jobId: job.id, err: err.message }, 'automation run failed permanently');
    await markRunFailed(deps, job.data as ExecuteRunJob, err.message).catch((e) => deps.log.error({ err: e }, 'failed to mark run'));
  });

  const maintenance = new Worker(QUEUES.maintenance, async (job) => {
    switch (job.name) {
      case 'sweep-inbound': return sweepStaleInboundEvents(deps);
      case 'rebalance-stage': return rebalanceStage(deps, job.data as RebalanceJob);
    }
  }, { connection, concurrency: 1 });

  // Планировщики с фиксированными id: несколько реплик воркера не размножат расписание
  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection });
  if (opts.sweepEveryMs !== 0) {
    await maintenanceQueue.upsertJobScheduler('sweep-inbound', { every: opts.sweepEveryMs ?? 60_000 }, { name: 'sweep-inbound' });
  }
  if (opts.staleScanEveryMs !== 0) {
    await deps.queues.automations.upsertJobScheduler('stale-scan', { every: opts.staleScanEveryMs ?? 15 * 60_000 }, { name: 'stale-scan', data: {} });
  }

  const relay = opts.relayIntervalMs === 0 ? null : startRelay(deps, opts.relayIntervalMs);
  const workers = [ingest, deliver, domainEvents, automations, maintenance];
  for (const w of workers) {
    w.on('error', (err) => deps.log.error({ err: err.message, queue: w.name }, 'worker error'));
    // В Sentry — только окончательные провалы: временные ошибки с успешным ретраем были бы шумом.
    // Теги очереди и workspace группируют инциденты по очереди, а не по стеку.
    w.on('failed', (job, err) => {
      if (!exhausted(job) && !(err instanceof UnrecoverableError)) return;
      Sentry.withScope((scope) => {
        scope.setTags({ queue: w.name, jobName: job?.name, jobId: job?.id, workspaceId: (job?.data as { workspaceId?: string } | undefined)?.workspaceId });
        Sentry.captureException(err);
      });
    });
  }

  return {
    async close() {
      await relay?.stop();
      await Promise.all(workers.map((w) => w.close()));
      await maintenanceQueue.close();
    },
  };
}
