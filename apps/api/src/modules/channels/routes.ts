import { channels } from '@crm/db';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../plugins/auth';

export interface ChannelDto {
  id: string;
  kind: 'website_form' | 'telegram';
  name: string;
  enabled: boolean;
  /** Путь для настройки у провайдера; секреты наружу не отдаются никогда */
  webhookPath: string;
}

export async function channelsRoutes(app: FastifyInstance) {
  app.get('/channels', {
    preHandler: requirePermission('settings:manage'),
  }, async (req): Promise<ChannelDto[]> => {
    const rows = await req.tx((tx) =>
      tx.select({ id: channels.id, kind: channels.kind, name: channels.name, enabled: channels.enabled })
        .from(channels).orderBy(asc(channels.name)));
    return rows.map((c) => ({ ...c, webhookPath: `/webhooks/${c.id}` }));
  });
}
