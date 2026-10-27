import type { Db, SecretBox } from '@crm/db';
import type { Publisher } from '@crm/realtime';
import type { Queue } from 'bullmq';
import type { IngestJob } from '@crm/contracts';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  db: Db;
  secrets: SecretBox;
  publisher: Publisher;
  ingestQueue: Queue<IngestJob>;
  log: Logger;
  /** Внедряется, чтобы тесты подменяли Telegram Bot API */
  fetch: typeof fetch;
  telegramApiUrl: string;
}
