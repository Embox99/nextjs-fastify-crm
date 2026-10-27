/** Имена очередей BullMQ — общие для API (producer) и воркера (consumer) */
export const QUEUES = {
  ingest: 'ingest',
  deliver: 'deliver',
  maintenance: 'maintenance',
  /** Доменные события из outbox → matcher автоматизаций */
  domainEvents: 'domain-events',
  /** Выполнение запусков, отложенные SLA-проверки, сканер неактивных сделок */
  automations: 'automations',
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

export interface RebalanceJob extends TenantJob {
  pipelineId: string;
  stageId: string;
}

export const rebalanceJobId = (stageId: string) => `rebalance-${stageId}`;

/**
 * jobId = id события: повторная постановка (ретрай вебхука, sweeper) не создаёт дубль.
 * Без ':' — BullMQ 6 запрещает его в пользовательских id (разделитель ключей Redis).
 */
export const ingestJobId = (inboundEventId: string) => `ingest-${inboundEventId}`;
export const deliverJobId = (messageId: string) => `deliver-${messageId}`;
