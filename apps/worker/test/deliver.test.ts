import { channels, conversations, messages } from '@crm/db';
import { UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { deliverMessage } from '../src/deliver/process';
import { processInboundEvent } from '../src/ingest/process';
import { insertEvent, makeDeps, type TestDeps } from './helpers';

const demo = inject('demo');
const calls: { url: string; body: any }[] = [];
let respond: () => Response;

let deps: TestDeps;
let conversationId: string;
const chatId = 777_000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  deps = makeDeps({
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return respond();
    },
  });
  await processInboundEvent(deps, await insertEvent(deps, 'telegram', {
    update_id: chatId, message: { message_id: 1, chat: { id: chatId }, from: { id: chatId, first_name: 'Клиент' }, text: 'Добрый день' },
  }));
  const [conv] = await deps.admin.db.select().from(conversations).where(eq(conversations.externalThreadId, String(chatId)));
  conversationId = conv!.id;
});

afterAll(async () => {
  await deps?.close();
});

beforeEach(async () => {
  calls.length = 0;
  await deps.admin.db.update(channels).set({ outboundToken: deps.secrets.seal('123:BOT') }).where(eq(channels.id, demo.channels.telegram));
});

async function pendingMessage(body = 'Здравствуйте!') {
  const [row] = await deps.admin.db.insert(messages).values({
    organizationId: demo.organizationId, workspaceId: demo.workspaceId, conversationId,
    direction: 'outbound', body, deliveryStatus: 'pending',
  }).returning();
  return { messageId: row!.id, organizationId: demo.organizationId, workspaceId: demo.workspaceId };
}

const statusOf = async (id: string) => (await deps.admin.db.select().from(messages).where(eq(messages.id, id)))[0]!;

describe('доставка в Telegram', () => {
  it('успех: sendMessage с расшифрованным токеном, статус sent, id сообщения Telegram, событие message.updated', async () => {
    respond = () => Response.json({ ok: true, result: { message_id: 4242 } });
    const job = await pendingMessage('Ответ менеджера');

    await deliverMessage(deps, job, false);

    expect(calls).toEqual([{ url: 'https://telegram.test/bot123:BOT/sendMessage', body: { chat_id: String(chatId), text: 'Ответ менеджера' } }]);
    expect(await statusOf(job.messageId)).toMatchObject({ deliveryStatus: 'sent', externalId: '4242', deliveryError: null });
    expect(deps.emitted.some((e) => e.event === 'message.updated' && e.payload.message.id === job.messageId)).toBe(true);
  });

  it('5xx — временная ошибка: исключение для ретрая, сообщение остаётся pending', async () => {
    respond = () => Response.json({ ok: false, description: 'Bad Gateway' }, { status: 502 });
    const job = await pendingMessage();
    await expect(deliverMessage(deps, job, false)).rejects.toThrow(/502/);
    expect((await statusOf(job.messageId)).deliveryStatus).toBe('pending');
  });

  it('последняя попытка исчерпана → failed с причиной', async () => {
    respond = () => Response.json({ ok: false, description: 'Too Many Requests' }, { status: 429 });
    const job = await pendingMessage();
    await expect(deliverMessage(deps, job, true)).rejects.toThrow(/429/);
    expect(await statusOf(job.messageId)).toMatchObject({ deliveryStatus: 'failed', deliveryError: expect.stringMatching(/429/) });
  });

  it('бот заблокирован (403) — постоянная ошибка без ретраев', async () => {
    respond = () => Response.json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    const job = await pendingMessage();
    await expect(deliverMessage(deps, job, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await statusOf(job.messageId)).deliveryStatus).toBe('failed');
  });

  it('токен не настроен — failed без обращения к Telegram', async () => {
    await deps.admin.db.update(channels).set({ outboundToken: null }).where(eq(channels.id, demo.channels.telegram));
    const job = await pendingMessage();
    await expect(deliverMessage(deps, job, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls).toEqual([]);
    expect(await statusOf(job.messageId)).toMatchObject({ deliveryStatus: 'failed', deliveryError: expect.stringMatching(/not configured/) });
  });

  it('уже доставленное сообщение повторно не отправляется', async () => {
    respond = () => Response.json({ ok: true, result: { message_id: 1 } });
    const job = await pendingMessage();
    await deliverMessage(deps, job, false);
    await deliverMessage(deps, job, false);
    expect(calls).toHaveLength(1);
  });
});
