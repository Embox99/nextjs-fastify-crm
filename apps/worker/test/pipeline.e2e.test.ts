import type { AddressInfo } from 'node:net';
import { buildApp } from '@crm/api/app';
import { contactIdentities, conversations, deals, inboundEvents, messages, systemContext, withRls } from '@crm/db';
import { DEMO_WEBSITE_SECRET } from '@crm/db';
import { TEST_SECRETS_KEY } from '@crm/db/testing';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sweepStaleInboundEvents } from '../src/maintenance/sweep';
import { startWorkers } from '../src/workers';
import { makeDeps, randomPhone, uniq, type TestDeps } from './helpers';

const demo = inject('demo');
let deps: TestDeps;
let api: Awaited<ReturnType<typeof buildApp>>;
let url: string;
let workers: Awaited<ReturnType<typeof startWorkers>>;

beforeAll(async () => {
  deps = makeDeps();
  api = await buildApp({
    db: deps.db, redis: deps.redis, jwtSecret: 'x'.repeat(32), secretsKey: TEST_SECRETS_KEY, corsOrigin: [],
  });
  await api.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  workers = await startWorkers(deps, { connection: deps.redis, ingestConcurrency: 10, sweepEveryMs: 0, staleScanEveryMs: 0 });
});

afterAll(async () => {
  await workers?.close();
  await api?.close();
  await deps?.close();
});

function signed(body: string, secret = DEMO_WEBSITE_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

async function postLead(payload: object, eventId: string) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${url}/webhooks/${demo.channels.website}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-event-id': eventId, 'x-signature': signed(body) },
    body,
  });
  return res.status;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

/** Простой пул: не больше `limit` запросов в полёте */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

describe('вебхук → очередь → воркер', () => {
  it('burst: 600 запросов, ~20% дублей, 120 телефонов — инварианты сохраняются', async () => {
    const run = uniq('burst');
    const phones = Array.from({ length: 120 }, randomPhone);
    const unique = Array.from({ length: 500 }, (_, i) => ({ eventId: `${run}-${i}`, phone: phones[i % phones.length]! }));
    // Дубли — повтор того же события провайдером (тот же event id и тело)
    const requests = [...unique, ...unique.slice(0, 100)].sort(() => Math.random() - 0.5);

    const statuses: number[] = [];
    const started = performance.now();
    await pool(requests, 50, async (r) => {
      statuses.push(await postLead({ name: 'Нагрузка', phone: r.phone, message: r.eventId }, r.eventId));
    });
    const httpMs = performance.now() - started;

    expect(statuses.filter((s) => s === 202)).toHaveLength(500);
    expect(statuses.filter((s) => s === 200)).toHaveLength(100);   // дубли отсечены

    const runEvents = sql`${inboundEvents.externalId} like ${`${run}-%`}`;
    await waitFor(async () => {
      const [row] = await deps.admin.db.select({ n: sql<number>`count(*)::int` }).from(inboundEvents)
        .where(and(runEvents, eq(inboundEvents.status, 'processed')));
      return row!.n === 500;
    });
    const totalMs = performance.now() - started;

    const identities = await deps.admin.db.select({ contactId: contactIdentities.contactId }).from(contactIdentities)
      .where(and(eq(contactIdentities.kind, 'phone'), inArray(contactIdentities.value, phones)));
    const contactIds = [...new Set(identities.map((i) => i.contactId))];
    expect(identities).toHaveLength(120);       // идентификатор на телефон — ровно один
    expect(contactIds).toHaveLength(120);       // контакт на телефон — ровно один

    const dealRows = await deps.admin.db.select({ contactId: deals.contactId }).from(deals).where(inArray(deals.contactId, contactIds));
    expect(dealRows).toHaveLength(120);         // повторные обращения не плодят сделки

    const [msgCount] = await deps.admin.db.select({ n: sql<number>`count(*)::int` }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(inArray(conversations.contactId, contactIds));
    expect(msgCount!.n).toBe(500);              // по сообщению на уникальное событие

    console.log(`burst: 600 req in ${Math.round(httpMs)} ms (${Math.round(600 / (httpMs / 1000))} req/s), drained in ${Math.round(totalMs)} ms`);
  }, 120_000);

  it('лид через вебхук сам распределяется менеджеру: outbox → relay → matcher → AssignManager', async () => {
    const phone = randomPhone();
    expect(await postLead({ name: 'Авто', phone, message: 'распредели меня' }, uniq('auto'))).toBe(202);

    await waitFor(async () => {
      const [row] = await deps.admin.db.select({ ownerId: deals.ownerId }).from(deals)
        .innerJoin(contactIdentities, eq(contactIdentities.contactId, deals.contactId))
        .where(and(eq(contactIdentities.kind, 'phone'), eq(contactIdentities.value, phone)));
      return Boolean(row?.ownerId);
    });
  });

  it('событие, потерянное между INSERT и enqueue, подхватывает sweeper', async () => {
    const phone = randomPhone();
    const [event] = await withRls(deps.db, systemContext(demo.organizationId, demo.workspaceId), (tx) =>
      tx.insert(inboundEvents).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, channelId: demo.channels.website,
        externalId: uniq('lost'), payload: { phone, message: 'потерян' },
        receivedAt: sql`now() - interval '5 minutes'`,
      }).returning());

    expect(await sweepStaleInboundEvents(deps)).toBeGreaterThanOrEqual(1);
    await waitFor(async () => {
      const [row] = await deps.admin.db.select().from(inboundEvents).where(eq(inboundEvents.id, event!.id));
      return row!.status === 'processed';
    });
  });
});
