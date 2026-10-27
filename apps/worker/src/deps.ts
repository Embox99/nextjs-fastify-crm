import type { DomainEvent, ExecuteRunJob, IngestJob, SlaCheckJob } from '@crm/contracts';
import type { Db, SecretBox } from '@crm/db';
import type { Publisher } from '@crm/realtime';
import type { Queue } from 'bullmq';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  db: Db;
  secrets: SecretBox;
  publisher: Publisher;
  queues: {
    ingest: Queue<IngestJob>;
    domainEvents: Queue<DomainEvent>;
    automations: Queue<ExecuteRunJob | SlaCheckJob | Record<string, never>>;
  };
  log: Logger;
  /** Внедряется, чтобы тесты подменяли Telegram Bot API */
  fetch: typeof fetch;
  telegramApiUrl: string;
}
