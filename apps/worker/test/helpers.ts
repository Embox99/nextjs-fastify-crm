import { QUEUES, type IngestJob } from '@crm/contracts';
import { createDb, createSecretBox, inboundEvents, type DbHandle } from '@crm/db';
import { TEST_SECRETS_KEY } from '@crm/db/testing';
import { createPublisher, type BroadcastTarget } from '@crm/realtime';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import type { WorkerDeps } from '../src/deps';

export interface Emitted {
  rooms: string[];
  event: string;
  payload: any;
}

/** Вместо Socket.io — запись того, что и в какие комнаты было бы отправлено */
export function recordingTarget(log: Emitted[]): BroadcastTarget {
  const op = (rooms: string[]) => ({
    emit: (event: string, payload: unknown) => void log.push({ rooms, event, payload }),
    except: () => op(rooms),
  });
  return { to: (room) => op(Array.isArray(room) ? room : [room]) };
}

export interface TestDeps extends WorkerDeps {
  emitted: Emitted[];
  admin: DbHandle;
  redis: Redis;
  close(): Promise<void>;
}

export function makeDeps(overrides: Partial<WorkerDeps> = {}): TestDeps {
  const app = createDb(inject('appUrl'), { max: 20 });
  const admin = createDb(inject('adminUrl'), { max: 2 });
  const redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
  const emitted: Emitted[] = [];
  const ingestQueue = new Queue<IngestJob>(QUEUES.ingest, { connection: redis });
  const silent = { info() {}, warn() {}, error() {} };

  return {
    db: app.db,
    secrets: createSecretBox(TEST_SECRETS_KEY),
    publisher: createPublisher(recordingTarget(emitted)),
    ingestQueue,
    log: silent,
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    telegramApiUrl: 'https://telegram.test',
    ...overrides,
    emitted,
    admin,
    redis,
    async close() {
      await ingestQueue.close();
      await Promise.all([app.close(), admin.close(), redis.quit()]);
    },
  };
}

let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/** Событие так, как его записал бы webhook-эндпоинт */
export async function insertEvent(deps: TestDeps, channel: 'website' | 'telegram', payload: unknown, externalId = uniq('evt')) {
  const demo = inject('demo');
  const [row] = await deps.admin.db.insert(inboundEvents).values({
    organizationId: demo.organizationId,
    workspaceId: demo.workspaceId,
    channelId: demo.channels[channel],
    externalId,
    payload,
  }).returning({ id: inboundEvents.id });
  return { inboundEventId: row!.id, organizationId: demo.organizationId, workspaceId: demo.workspaceId };
}

/** Случайный валидный российский мобильный */
export const randomPhone = () => `+7916${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
