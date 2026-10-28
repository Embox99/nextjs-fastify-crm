import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadAuthContext } from '../src/auth-context';
import { createDb, type DbHandle } from '../src/client';
import { channelOutboundToken, findWebhookChannel } from '../src/inbox';
import { channels, contacts, conversations, inboundEvents, messages } from '../src/schema';
import { createSecretBox } from '../src/secrets';
import { DEMO_WEBSITE_SECRET, type DemoSeed } from '../src/seed/demo';
import { TEST_SECRETS_KEY } from '../src/testing';
import { systemContext, withRls } from '../src/with-rls';

let admin: DbHandle;
let app: DbHandle;
let demo: DemoSeed;
const box = createSecretBox(TEST_SECRETS_KEY);

beforeAll(async () => {
  admin = createDb(inject('adminUrl'), { max: 1 });
  app = createDb(inject('appUrl'), { max: 2 });
  demo = inject('demo');
});

afterAll(async () => {
  await Promise.all([admin?.close(), app?.close()]);
});

const ctx = (user: keyof DemoSeed['users']) => loadAuthContext(app.db, demo.users[user], demo.workspaceId);

describe('секреты каналов', () => {
  it('шифрование: round-trip, разный шифртекст на каждый seal, подмена ломает расшифровку', () => {
    const a = box.seal('s3cret');
    expect(box.open(a)).toBe('s3cret');
    expect(box.seal('s3cret')).not.toBe(a);
    const [v, iv, tag, data] = a.split(':');
    const tampered = [v, iv, tag, Buffer.from('x' + data).toString('base64')].join(':');
    expect(() => box.open(tampered)).toThrow();
  });

  it('роль приложения не читает секретные колонки, но канал без секретов виден', async () => {
    const adm = await ctx('admin');
    const err = await withRls(app.db, adm, (tx) => tx.select().from(channels)).then(() => null, (e) => e.cause ?? e);
    expect(err?.message).toMatch(/permission denied/);

    const visible = await withRls(app.db, adm, (tx) => tx.select({ id: channels.id, name: channels.name }).from(channels));
    expect(visible.map((c) => c.name).sort()).toEqual(['Telegram bot', 'Website form']);
  });

  it('webhook_channel отдаёт тенанта и зашифрованный секрет по id без контекста', async () => {
    const channel = await findWebhookChannel(app.db, demo.channels.website);
    expect(channel).toMatchObject({ organizationId: demo.organizationId, workspaceId: demo.workspaceId, kind: 'website_form' });
    expect(box.open(channel!.sealedSecrets[0]!)).toBe(DEMO_WEBSITE_SECRET);
    expect(await findWebhookChannel(app.db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('outbound-токен читается только в контексте своего workspace', async () => {
    await admin.db.update(channels).set({ outboundToken: box.seal('bot-token') }).where(eq(channels.id, demo.channels.telegram));
    const own = await withRls(app.db, systemContext(demo.organizationId, demo.workspaceId), (tx) =>
      channelOutboundToken(tx, demo.channels.telegram));
    expect(box.open(own!)).toBe('bot-token');

    const noContext = await app.db.transaction((tx) => channelOutboundToken(tx, demo.channels.telegram));
    expect(noContext).toBeNull();
  });

  it('создавать каналы может только scope=all', async () => {
    const values = {
      organizationId: demo.organizationId, workspaceId: demo.workspaceId, kind: 'website_form' as const,
      name: 'x', webhookSecret: 'x', defaultPipelineId: demo.pipelineId,
    };
    const err = await withRls(app.db, await ctx('lead'), (tx) => tx.insert(channels).values(values))
      .then(() => null, (e) => e.cause ?? e);
    expect(err?.message).toMatch(/row-level security/);
  });
});

describe('RLS инбокса', () => {
  it('диалоги и сообщения видны как сделки: ответственному, лиду команды, админу', async () => {
    const sys = systemContext(demo.organizationId, demo.workspaceId);
    await withRls(app.db, sys, async (tx) => {
      const [contact] = await tx.insert(contacts)
        .values({ organizationId: demo.organizationId, workspaceId: demo.workspaceId, fullName: 'Inbox RLS' }).returning();
      const [conv] = await tx.insert(conversations).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, channelId: demo.channels.telegram,
        externalThreadId: 'rls-thread', contactId: contact!.id, assigneeId: demo.users.rep1, teamId: demo.teams.enterprise,
      }).returning();
      await tx.insert(messages).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, conversationId: conv!.id,
        direction: 'inbound', body: 'hello', deliveryStatus: 'received',
      });
    });

    const count = async (user: keyof DemoSeed['users']) => withRls(app.db, await ctx(user), async (tx) => ({
      conversations: (await tx.select().from(conversations).where(eq(conversations.externalThreadId, 'rls-thread'))).length,
      messages: (await tx.select({ n: sql<number>`count(*)::int` }).from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(eq(conversations.externalThreadId, 'rls-thread')))[0]!.n,
    }));

    expect(await count('rep1')).toEqual({ conversations: 1, messages: 1 });
    expect(await count('lead')).toEqual({ conversations: 1, messages: 1 });
    expect(await count('admin')).toEqual({ conversations: 1, messages: 1 });
    expect(await count('rep2')).toEqual({ conversations: 0, messages: 0 });
    expect(await count('rep3')).toEqual({ conversations: 0, messages: 0 });
  });

  it('сырые входящие события видны только scope=all', async () => {
    await withRls(app.db, systemContext(demo.organizationId, demo.workspaceId), (tx) =>
      tx.insert(inboundEvents).values({
        organizationId: demo.organizationId, workspaceId: demo.workspaceId, channelId: demo.channels.website,
        externalId: 'rls-evt', payload: {},
      }));
    const asLead = await withRls(app.db, await ctx('lead'), (tx) => tx.select().from(inboundEvents));
    const asAdmin = await withRls(app.db, await ctx('admin'), (tx) => tx.select().from(inboundEvents));
    expect(asLead).toEqual([]);
    expect(asAdmin.some((e) => e.externalId === 'rls-evt')).toBe(true);
  });
});
