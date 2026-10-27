import { createHash } from 'node:crypto';
import type { ConversationDto, MessageDto } from '@crm/contracts';
import { ingestJobId } from '@crm/contracts';
import {
  channels, contacts, conversations, createDb, createSecretBox, DEMO_TELEGRAM_SECRET, DEMO_WEBSITE_SECRET,
  inboundEvents, messages, type DbHandle,
} from '@crm/db';
import { TEST_SECRETS_KEY } from '@crm/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { signPayload, verifyHmacSignature, verifySecretToken } from '../src/modules/webhooks/signature';
import { as, startReplica, type Replica } from './helpers';

const demo = inject('demo');
let api: Replica;
let admin: DbHandle;
let seq = 0;

beforeAll(async () => {
  api = await startReplica();
  admin = createDb(inject('adminUrl'), { max: 1 });
});

afterAll(async () => {
  await api?.close();
  await admin?.close();
});

function postWebsite(body: string, headers: Record<string, string> = {}) {
  return api.app.inject({
    method: 'POST',
    url: `/webhooks/${demo.channels.website}`,
    headers: { 'content-type': 'application/json', 'x-signature': signPayload(body, DEMO_WEBSITE_SECRET), ...headers },
    payload: body,
  });
}

const lead = () => JSON.stringify({ name: 'Тест', phone: '+79160000000', n: ++seq, at: Date.now() });

describe('подпись', () => {
  const raw = Buffer.from('{"a":1}');

  it('HMAC: верная подпись, подмена тела, просроченная метка, ротация ключа', () => {
    const now = Date.now();
    expect(verifyHmacSignature(raw, signPayload(raw, 'k1'), ['k1'])).toBe(true);
    expect(verifyHmacSignature(Buffer.from('{"a":2}'), signPayload(raw, 'k1'), ['k1'])).toBe(false);
    expect(verifyHmacSignature(raw, signPayload(raw, 'k1', Math.floor(now / 1000) - 3600), ['k1'], now)).toBe(false);
    expect(verifyHmacSignature(raw, signPayload(raw, 'old'), ['new', 'old'])).toBe(true);
    expect(verifyHmacSignature(raw, 't=1,v1=zz', ['k1'])).toBe(false);
    expect(verifyHmacSignature(raw, undefined, ['k1'])).toBe(false);
  });

  it('Telegram secret token сравнивается в постоянном времени', () => {
    expect(verifySecretToken('abc', ['abc'])).toBe(true);
    expect(verifySecretToken('abd', ['abc'])).toBe(false);
    expect(verifySecretToken('ab', ['abc'])).toBe(false);
  });
});

describe('POST /webhooks/:channelId', () => {
  it('валидный запрос → 202, сырое событие в БД, задача в очереди с jobId события', async () => {
    const body = lead();
    const res = await postWebsite(body, { 'x-event-id': `evt-${seq}` });
    expect(res.statusCode).toBe(202);

    const { id } = res.json<{ id: string }>();
    const [event] = await admin.db.select().from(inboundEvents).where(eq(inboundEvents.id, id));
    expect(event).toMatchObject({ status: 'received', externalId: `evt-${seq}`, payload: JSON.parse(body) });

    const job = await api.app.queues.ingest.getJob(ingestJobId(id));
    expect(job?.data).toEqual({ inboundEventId: id, organizationId: demo.organizationId, workspaceId: demo.workspaceId });
  });

  it('повтор того же события → 200 duplicate, второй записи нет', async () => {
    const body = lead();
    const first = await postWebsite(body, { 'x-event-id': 'dup-1' });
    const second = await postWebsite(body, { 'x-event-id': 'dup-1' });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ duplicate: true });
  });

  it('Redis-ключ истёк — дубль всё равно отсекает unique в БД', async () => {
    const body = lead();
    expect((await postWebsite(body, { 'x-event-id': 'dup-2' })).statusCode).toBe(202);
    await api.app.redis.del(`idem:${demo.channels.website}:dup-2`);
    const again = await postWebsite(body, { 'x-event-id': 'dup-2' });
    expect(again.statusCode).toBe(200);
    expect((await admin.db.select().from(inboundEvents).where(eq(inboundEvents.externalId, 'dup-2')))).toHaveLength(1);
  });

  it('без x-event-id идемпотентность держится на хеше тела', async () => {
    const body = lead();
    expect((await postWebsite(body)).statusCode).toBe(202);
    expect((await postWebsite(body)).statusCode).toBe(200);
    const hash = createHash('sha256').update(body).digest('hex');
    expect(await admin.db.select().from(inboundEvents).where(eq(inboundEvents.externalId, hash))).toHaveLength(1);
  });

  it('неверная подпись → 401, неизвестный канал → 404, не JSON → 400', async () => {
    expect((await postWebsite(lead(), { 'x-signature': signPayload(lead(), 'wrong') })).statusCode).toBe(401);
    expect((await postWebsite(lead(), { 'x-signature': '' })).statusCode).toBe(401);

    const unknown = await api.app.inject({
      method: 'POST', url: '/webhooks/00000000-0000-4000-8000-000000000000',
      headers: { 'content-type': 'application/json' }, payload: '{}',
    });
    expect(unknown.statusCode).toBe(404);

    const notJson = 'name=x';
    expect((await postWebsite(notJson, { 'content-type': 'text/plain', 'x-signature': signPayload(notJson, DEMO_WEBSITE_SECRET) })).statusCode).toBe(400);
  });

  it('ротация: старый секрет принимается, пока он previous', async () => {
    const box = createSecretBox(TEST_SECRETS_KEY);
    const rotated = createSecretBox(TEST_SECRETS_KEY).seal('new-website-secret');
    await admin.db.update(channels).set({ webhookSecret: rotated, previousWebhookSecret: box.seal(DEMO_WEBSITE_SECRET) })
      .where(eq(channels.id, demo.channels.website));
    // Канал кэшируется на 30 с — новая реплика читает свежий
    const fresh = await startReplica();
    try {
      const body = lead();
      const viaOld = await fresh.app.inject({
        method: 'POST', url: `/webhooks/${demo.channels.website}`,
        headers: { 'content-type': 'application/json', 'x-signature': signPayload(body, DEMO_WEBSITE_SECRET) }, payload: body,
      });
      const body2 = lead();
      const viaNew = await fresh.app.inject({
        method: 'POST', url: `/webhooks/${demo.channels.website}`,
        headers: { 'content-type': 'application/json', 'x-signature': signPayload(body2, 'new-website-secret') }, payload: body2,
      });
      expect([viaOld.statusCode, viaNew.statusCode]).toEqual([202, 202]);
    } finally {
      await admin.db.update(channels).set({ webhookSecret: box.seal(DEMO_WEBSITE_SECRET), previousWebhookSecret: null })
        .where(eq(channels.id, demo.channels.website));
      await fresh.close();
    }
  });

  it('Telegram: secret token в заголовке, id события — update_id', async () => {
    const update = { update_id: 900_000 + seq++, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: 'hi' } };
    const send = (token: string) => api.app.inject({
      method: 'POST', url: `/webhooks/${demo.channels.telegram}`,
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token },
      payload: JSON.stringify(update),
    });
    expect((await send('wrong')).statusCode).toBe(401);
    expect((await send(DEMO_TELEGRAM_SECRET)).statusCode).toBe(202);
    expect((await send(DEMO_TELEGRAM_SECRET)).statusCode).toBe(200);
    expect(await admin.db.select().from(inboundEvents).where(eq(inboundEvents.externalId, String(update.update_id)))).toHaveLength(1);
  });
});

describe('инбокс', () => {
  async function conversationFor(assignee: string | null, kind: 'telegram' | 'website' = 'telegram') {
    const [contact] = await admin.db.insert(contacts)
      .values({ organizationId: demo.organizationId, workspaceId: demo.workspaceId, fullName: 'Клиент инбокса' }).returning();
    const [conv] = await admin.db.insert(conversations).values({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, channelId: demo.channels[kind],
      externalThreadId: `thread-${++seq}`, contactId: contact!.id, assigneeId: assignee, teamId: demo.teams.enterprise,
    }).returning();
    await admin.db.insert(messages).values({
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, conversationId: conv!.id,
      direction: 'inbound', body: 'Добрый день', deliveryStatus: 'received',
    });
    return conv!.id;
  }

  it('список и сообщения видны по правилам сделок', async () => {
    const own = await conversationFor(demo.users.rep1);
    const colleague = await conversationFor(demo.users.rep2);
    const [rep1, lead] = await Promise.all([as(api.app, 'rep1'), as(api.app, 'lead')]);

    const mine = (await rep1.get<ConversationDto[]>('/conversations')).body.map((c) => c.id);
    expect(mine).toContain(own);
    expect(mine).not.toContain(colleague);
    expect((await lead.get<ConversationDto[]>('/conversations')).body.map((c) => c.id)).toEqual(expect.arrayContaining([own, colleague]));

    expect((await rep1.get<MessageDto[]>(`/conversations/${own}/messages`)).body.map((m) => m.body)).toEqual(['Добрый день']);
    expect((await rep1.get(`/conversations/${colleague}/messages`)).status).toBe(404);
  });

  it('ответ сохраняется как pending и ставит задачу доставки', async () => {
    const conv = await conversationFor(demo.users.rep1);
    const rep1 = await as(api.app, 'rep1');
    const res = await rep1.post<MessageDto>(`/conversations/${conv}/messages`, { body: 'Здравствуйте! Чем помочь?' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ direction: 'outbound', deliveryStatus: 'pending', authorId: demo.users.rep1 });

    const job = await api.app.queues.deliver.getJob(`deliver-${res.body.id}`);
    expect(job?.data.messageId).toBe(res.body.id);

    const list = (await rep1.get<ConversationDto[]>('/conversations')).body;
    expect(list.find((c) => c.id === conv)?.lastMessagePreview).toBe('Здравствуйте! Чем помочь?');
  });

  it('форма сайта не поддерживает ответы → 422', async () => {
    const conv = await conversationFor(demo.users.rep1, 'website');
    const rep1 = await as(api.app, 'rep1');
    expect((await rep1.post(`/conversations/${conv}/messages`, { body: 'x' })).status).toBe(422);
  });
});
