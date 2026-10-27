import type { AddressInfo } from 'node:net';
import type { BoardDto, ClientToServerEvents, DealDto, ServerToClientEvents } from '@crm/contracts';
import { createDb, DEMO_ORG, DEMO_PASSWORD } from '@crm/db';
import { TEST_SECRETS_KEY } from '@crm/db/testing';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { inject } from 'vitest';
import { buildApp } from '../src/app';

export const JWT_SECRET = 'test-secret-test-secret-test-secret!!';

export interface Replica {
  app: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

/** Полноценная реплика API: свой пул БД, свой Redis-клиент, реальный порт. */
export async function startReplica(): Promise<Replica> {
  const { db, close: closeDb } = createDb(inject('appUrl'), { max: 5 });
  const redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
  const app = await buildApp({
    db, redis, jwtSecret: JWT_SECRET, secretsKey: TEST_SECRETS_KEY, corsOrigin: ['http://localhost:3000'],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    app,
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    async close() {
      await app.close();
      await Promise.all([closeDb(), redis.quit()]);
    },
  };
}

export type DemoUser = 'admin' | 'lead' | 'rep1' | 'rep2' | 'rep3';

export async function login(app: FastifyInstance, user: DemoUser): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { organization: DEMO_ORG, email: `${user}@acme.test`, password: DEMO_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return res.json<{ token: string }>().token;
}

/** HTTP-клиент от имени пользователя в демо-workspace */
export async function as(app: FastifyInstance, user: DemoUser) {
  const token = await login(app, user);
  const workspaceId = inject('demo').workspaceId;
  const headers = { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId };

  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const res = await app.inject({ method, url, headers, ...(payload && { payload }) });
    return { status: res.statusCode, body: res.json<T>() };
  };

  return {
    token,
    workspaceId,
    get: <T>(url: string) => call<T>('GET', url),
    post: <T>(url: string, payload: object) => call<T>('POST', url, payload),
    patch: <T>(url: string, payload: object) => call<T>('PATCH', url, payload),
    board: async () => (await call<BoardDto>('GET', `/pipelines/${inject('demo').pipelineId}/board`)).body,
    createDeal: async (title: string, extra: object = {}) => {
      const res = await call<DealDto>('POST', '/deals', { pipelineId: inject('demo').pipelineId, title, ...extra });
      if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
      return res.body;
    },
  };
}

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export async function connect(url: string, auth: { token: string; workspaceId: string }): Promise<ClientSocket> {
  const socket: ClientSocket = io(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

type EventArg<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

/** Ждёт событие, удовлетворяющее предикату; остальные события того же типа пропускает */
export function nextEvent<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (e: EventArg<E>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<EventArg<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (e: EventArg<E>) => {
      if (!predicate(e)) return;
      clearTimeout(timer);
      socket.off(event, handler as never);
      resolve(e);
    };
    socket.on(event, handler as never);
  });
}

/** Утверждение «событие НЕ пришло» за окно времени */
export async function expectNoEvent<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (e: EventArg<E>) => boolean = () => true,
  windowMs = 400,
): Promise<void> {
  const received = await nextEvent(socket, event, predicate, windowMs).then(() => true, () => false);
  if (received) throw new Error(`unexpected ${event}`);
}

export function emitAck<E extends 'deal.open' | 'deal.edit.start'>(
  socket: ClientSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
): Promise<Parameters<Parameters<ClientToServerEvents[E]>[1]>[0]> {
  return new Promise((resolve) => (socket.emit as (...args: unknown[]) => void)(event, payload, resolve));
}
