import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Миграции выполняются под владельцем схемы (MIGRATION_DATABASE_URL), не под ролью приложения. */
export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
  await runMigrations(url);
  console.log('migrations applied');
}
