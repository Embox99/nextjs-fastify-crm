import { createHash } from 'node:crypto';
import { ingestJobId, type IngestJob } from '@crm/contracts';
import { findWebhookChannel, inboundEvents, systemContext, withRls, type WebhookChannel } from '@crm/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyHmacSignature, verifySecretToken } from './signature';

const Params = z.object({ channelId: z.uuid() });
const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;
const CHANNEL_CACHE_MS = 30_000;

interface CachedChannel extends Omit<WebhookChannel, 'sealedSecrets'> {
  secrets: string[];
  expiresAt: number;
}

/**
 * Приём лидов: проверка подписи → идемпотентность → сырое событие в БД → задача в очередь → 202.
 * Никакой бизнес-логики в запросе: провайдер получает ответ за миллисекунды, а сбой обработки
 * не превращается в его ретраи.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // Сырые байты нужны для HMAC — парсер JSON заменён только внутри этого плагина
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const cache = new Map<string, CachedChannel>();
  async function channelById(id: string): Promise<CachedChannel | null> {
    const hit = cache.get(id);
    if (hit && hit.expiresAt > Date.now()) return hit;
    const found = await findWebhookChannel(app.db, id);
    if (!found) return null;
    const { sealedSecrets, ...rest } = found;
    const channel = { ...rest, secrets: sealedSecrets.map((s) => app.secrets.open(s)), expiresAt: Date.now() + CHANNEL_CACHE_MS };
    cache.set(id, channel);
    return channel;
  }

  app.post('/webhooks/:channelId', {
    config: { public: true },
    bodyLimit: 256 * 1024,
  }, async (req, reply) => {
    const { channelId } = Params.parse(req.params);
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return reply.badRequest('Empty body');

    const channel = await channelById(channelId);
    if (!channel?.enabled) return reply.notFound();

    const verified = channel.kind === 'telegram'
      ? verifySecretToken(header(req.headers['x-telegram-bot-api-secret-token']), channel.secrets)
      : verifyHmacSignature(raw, header(req.headers['x-signature']), channel.secrets);
    if (!verified) {
      req.log.warn({ channelId }, 'webhook signature mismatch');
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.badRequest('Body must be JSON');
    }

    const externalId = eventId(channel.kind, payload, header(req.headers['x-event-id']))
      ?? createHash('sha256').update(raw).digest('hex');

    // Быстрый фильтр дублей. Источник истины — unique (channel_id, external_id) в БД.
    const idemKey = `idem:${channelId}:${externalId}`;
    if (!(await app.redis.set(idemKey, '1', 'EX', IDEMPOTENCY_TTL_SEC, 'NX'))) {
      return reply.code(200).send({ duplicate: true });
    }

    try {
      const tenant = systemContext(channel.organizationId, channel.workspaceId);
      const [event] = await withRls(app.db, tenant, (tx) =>
        tx.insert(inboundEvents).values({
          organizationId: channel.organizationId,
          workspaceId: channel.workspaceId,
          channelId,
          externalId,
          payload,
        }).onConflictDoNothing().returning({ id: inboundEvents.id }));

      // Redis-ключ истёк, а событие уже было — БД помнит дольше
      if (!event) return reply.code(200).send({ duplicate: true });

      const job: IngestJob = { inboundEventId: event.id, organizationId: channel.organizationId, workspaceId: channel.workspaceId };
      await app.queues.ingest.add('ingest', job, { jobId: ingestJobId(event.id) });
      return reply.code(202).send({ id: event.id });
    } catch (err) {
      // Отпускаем ключ, чтобы ретрай провайдера прошёл. Если упал только enqueue — событие
      // уже в БД со статусом received, и его доставит в очередь sweeper воркера.
      await app.redis.del(idemKey);
      throw err;
    }
  });
}

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Стабильный id события у провайдера; без него идемпотентность держится на хеше тела */
function eventId(kind: WebhookChannel['kind'], payload: unknown, headerId: string | undefined): string | undefined {
  if (kind === 'telegram') {
    const updateId = (payload as { update_id?: unknown } | null)?.update_id;
    return typeof updateId === 'number' ? String(updateId) : undefined;
  }
  return headerId?.slice(0, 200) || undefined;
}
