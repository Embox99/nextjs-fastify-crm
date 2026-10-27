import * as Sentry from '@sentry/node';

// Импортируется первым в server.ts: SDK должен инициализироваться до загрузки модулей, которые он инструментирует.
// Без SENTRY_DSN — no-op: локально и в тестах ничего никуда не отправляется.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    initialScope: { tags: { service: 'api' } },
  });
}
