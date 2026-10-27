/** Имена очередей BullMQ — общие для API (producer) и воркера (consumer) */
export const QUEUES = {
  ingest: 'ingest',
  deliver: 'deliver',
  maintenance: 'maintenance',
} as const;

interface TenantJob {
  organizationId: string;
  workspaceId: string;
}

export interface IngestJob extends TenantJob {
  inboundEventId: string;
}

export interface DeliverJob extends TenantJob {
  messageId: string;
}

/**
 * jobId = id события: повторная постановка (ретрай вебхука, sweeper) не создаёт дубль.
 * Без ':' — BullMQ 6 запрещает его в пользовательских id (разделитель ключей Redis).
 */
export const ingestJobId = (inboundEventId: string) => `ingest-${inboundEventId}`;
export const deliverJobId = (messageId: string) => `deliver-${messageId}`;
