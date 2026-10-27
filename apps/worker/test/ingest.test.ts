import { contactIdentities, contacts, conversations, deals, inboundEvents, mergeCandidates, messages } from '@crm/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processInboundEvent } from '../src/ingest/process';
import { insertEvent, makeDeps, randomPhone, uniq, type TestDeps } from './helpers';

let deps: TestDeps;
const demo = inject('demo');

beforeAll(() => {
  deps = makeDeps();
});

afterAll(async () => {
  await deps?.close();
});

const contactIdsByIdentity = async (kind: 'phone' | 'email' | 'telegram', value: string) =>
  (await deps.admin.db.select({ id: contactIdentities.contactId }).from(contactIdentities)
    .where(and(eq(contactIdentities.kind, kind), eq(contactIdentities.value, value)))).map((r) => r.id);

describe('лид с формы сайта', () => {
  it('создаёт контакт, идентификаторы, сделку, диалог и сообщение; публикует события', async () => {
    const phone = randomPhone();
    const email = `${uniq('lead')}@example.com`;
    const job = await insertEvent(deps, 'website', { name: 'Пётр', phone, email, message: 'Нужен аудит', title: 'Аудит сети' });

    expect(await processInboundEvent(deps, job)).toBe('processed');

    const [contactId] = await contactIdsByIdentity('phone', phone);
    expect(await contactIdsByIdentity('email', email)).toEqual([contactId]);

    const [deal] = await deps.admin.db.select().from(deals).where(eq(deals.contactId, contactId!));
    expect(deal).toMatchObject({ title: 'Аудит сети', stageId: demo.stages.new, ownerId: null });
    expect(deal!.lastActivityAt).not.toBeNull();

    const [conv] = await deps.admin.db.select().from(conversations).where(eq(conversations.contactId, contactId!));
    expect(conv).toMatchObject({ externalThreadId: email, dealId: deal!.id, lastMessagePreview: 'Нужен аудит' });
    const msgs = await deps.admin.db.select().from(messages).where(eq(messages.conversationId, conv!.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'inbound', body: 'Нужен аудит', deliveryStatus: 'received' });

    const [event] = await deps.admin.db.select().from(inboundEvents).where(eq(inboundEvents.id, job.inboundEventId));
    expect(event).toMatchObject({ status: 'processed', attempts: 1 });

    const events = deps.emitted.filter((e) => [deal!.id, conv!.id].includes(e.payload.deal?.id ?? e.payload.conversation?.id ?? e.payload.message?.conversationId));
    expect(events.map((e) => e.event).sort()).toEqual(['conversation.upserted', 'deal.upserted', 'message.created']);
    // Неназначенная сделка видна только админам workspace
    expect(events.find((e) => e.event === 'deal.upserted')!.rooms).toEqual([`ws:${demo.workspaceId}:all`]);
  });

  it('повторное обращение того же клиента: тот же контакт, новый email прикреплён, сделка не дублируется', async () => {
    const phone = randomPhone();
    await processInboundEvent(deps, await insertEvent(deps, 'website', { phone, message: 'первое' }));
    const second = `${uniq('second')}@example.com`;
    await processInboundEvent(deps, await insertEvent(deps, 'website', { phone, email: second, message: 'второе' }));

    const [contactId] = await contactIdsByIdentity('phone', phone);
    expect(await contactIdsByIdentity('email', second)).toEqual([contactId]);
    expect(await deps.admin.db.select().from(deals).where(eq(deals.contactId, contactId!))).toHaveLength(1);
  });

  it('повторная обработка того же события ничего не меняет', async () => {
    const job = await insertEvent(deps, 'website', { phone: randomPhone(), message: 'once' });
    expect(await processInboundEvent(deps, job)).toBe('processed');
    expect(await processInboundEvent(deps, job)).toBe('already_done');
  });

  it('невалидный payload → failed с причиной, без ретраев', async () => {
    const job = await insertEvent(deps, 'website', { name: 'без контактов' });
    expect(await processInboundEvent(deps, job)).toBe('invalid');
    const [event] = await deps.admin.db.select().from(inboundEvents).where(eq(inboundEvents.id, job.inboundEventId));
    expect(event!.status).toBe('failed');
    expect(event!.error).toMatch(/neither a valid phone nor email/);
  });
});

describe('конкурентность', () => {
  it('50 параллельных лидов с одним телефоном → один контакт, одна сделка, один диалог, 50 сообщений', async () => {
    const phone = randomPhone();
    const jobs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      insertEvent(deps, 'website', { name: `Лид ${i}`, phone, message: `сообщение ${i}` })));

    const outcomes = await Promise.all(jobs.map((job) => processInboundEvent(deps, job)));
    expect(outcomes.every((o) => o === 'processed')).toBe(true);

    const contactIds = await contactIdsByIdentity('phone', phone);
    expect(contactIds).toHaveLength(1);
    expect(await deps.admin.db.select().from(deals).where(eq(deals.contactId, contactIds[0]!))).toHaveLength(1);
    const convs = await deps.admin.db.select().from(conversations).where(eq(conversations.contactId, contactIds[0]!));
    expect(convs).toHaveLength(1);
    expect(await deps.admin.db.select().from(messages).where(eq(messages.conversationId, convs[0]!.id))).toHaveLength(50);
  });

  it('телефон ведёт к одному контакту, email — к другому → задача на слияние, а не тихая склейка', async () => {
    const phone = randomPhone();
    const email = `${uniq('conflict')}@example.com`;
    await processInboundEvent(deps, await insertEvent(deps, 'website', { phone }));
    await processInboundEvent(deps, await insertEvent(deps, 'website', { email }));
    const [byPhone] = await contactIdsByIdentity('phone', phone);
    const [byEmail] = await contactIdsByIdentity('email', email);
    expect(byPhone).not.toBe(byEmail);

    await processInboundEvent(deps, await insertEvent(deps, 'website', { phone, email, message: 'это я' }));

    const candidates = await deps.admin.db.select().from(mergeCandidates);
    const expected = [byPhone!, byEmail!].sort();
    expect(candidates.some((c) => JSON.stringify(c.contactIds) === JSON.stringify(expected))).toBe(true);
    // Новые идентификаторы не перепривязываются к другому контакту
    expect(await contactIdsByIdentity('email', email)).toEqual([byEmail]);
  });
});

describe('Telegram', () => {
  const update = (chatId: number, updateId: number, message: object) => ({
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId }, from: { id: chatId, first_name: 'Ольга' }, ...message },
  });

  it('сообщения одного чата — один диалог; контакт по telegram id', async () => {
    const chatId = Math.floor(Math.random() * 1e9);
    await processInboundEvent(deps, await insertEvent(deps, 'telegram', update(chatId, 1, { text: 'Здравствуйте' })));
    await processInboundEvent(deps, await insertEvent(deps, 'telegram', update(chatId, 2, { text: 'Сколько стоит?' })));

    const contactIds = await contactIdsByIdentity('telegram', String(chatId));
    expect(contactIds).toHaveLength(1);
    const [contact] = await deps.admin.db.select().from(contacts).where(inArray(contacts.id, contactIds));
    expect(contact!.fullName).toBe('Ольга');

    const convs = await deps.admin.db.select().from(conversations)
      .where(and(eq(conversations.channelId, demo.channels.telegram), eq(conversations.externalThreadId, String(chatId))));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.lastMessagePreview).toBe('Сколько стоит?');
  });

  it('edited_message игнорируется и закрывает событие', async () => {
    const job = await insertEvent(deps, 'telegram', { update_id: 99, edited_message: { text: 'x' } });
    expect(await processInboundEvent(deps, job)).toBe('ignored');
    const [event] = await deps.admin.db.select().from(inboundEvents).where(eq(inboundEvents.id, job.inboundEventId));
    expect(event!.status).toBe('processed');
  });
});
