# Lead-to-Deal Engine

CRM для сервисного B2B: лиды → сделки, омниканальный инбокс, движок автоматизаций.
Архитектура и решения — в [docs/DESIGN.md](docs/DESIGN.md).

## Состояние

| Неделя | Что готово |
|---|---|
| 1 | Монорепо (pnpm + Turborepo), Docker Compose, Drizzle-схема, RLS-изоляция и видимость `all/team/own`, `withRls`, аудит-триггер, RBAC-матрица интеграционных тестов |
| 2 | Fastify API (вход по паролю через pgcrypto, JWT, доска, создание/правка/перемещение сделок), fractional indexing, Socket.io + Redis-адаптер с комнатами по RBAC, presence и мягкие блокировки, Next.js-канбан на dnd-kit с оптимистичными апдейтами |

## Быстрый старт

Нужны Node 24+, Docker и pnpm (`corepack enable`).

```bash
pnpm install
cp .env.example .env   # задайте JWT_SECRET (32+ символа)
pnpm db:up             # Postgres :5434, Redis :6380
pnpm db:migrate        # под владельцем схемы (MIGRATION_DATABASE_URL)
pnpm db:seed           # демо-организация acme
pnpm dev               # API :4000, web :3000
pnpm test              # Postgres и Redis поднимаются через Testcontainers
```

Вход: организация `acme`, пароль `demo`, пользователи `admin@`, `lead@`, `rep1@`, `rep2@`, `rep3@acme.test`.
Чтобы увидеть real-time, откройте доску под разными пользователями в разных профилях браузера
(сессия хранится в localStorage и общая для вкладок одного профиля).

## Структура

```
apps/api             Fastify: REST, Socket.io-шлюз (realtime/), вход и AuthContext (auth/)
apps/web             Next.js App Router: доска (features/board), realtime-провайдер
packages/contracts   zod-схемы DTO и типы WS-событий — общие для api и web
packages/domain      чистая логика: ранжирование, видимость/комнаты, применение событий к доске
packages/db
  src/schema/        Drizzle-схема (составные FK против ссылок между тенантами)
  src/with-rls.ts    транзакция с RLS-контекстом в transaction-local GUC
  src/auth-context.ts  сборка контекста из membership (app.resolve_auth_context)
  migrations/0000_init.sql  сгенерировано drizzle-kit
  migrations/0001_rls.sql   роль crm_app, функции контекста, политики, audit_logs
  test/rls.matrix.test.ts   матрица доступа + регресс-тесты схемы
```

## Модель ролей БД

- **Владелец схемы** (`crm_owner` локально) — выполняет миграции. В проде ему нужен `BYPASSRLS`:
  от его имени работают `SECURITY DEFINER`-функции (`resolve_auth_context`, аудит-триггер).
- **`crm_app`** — NOLOGIN-роль с правами на таблицы, без `BYPASSRLS`.
- **`crm_app_user`** — логин приложения, член `crm_app`. Все запросы проходят через RLS;
  без `withRls` приложение не видит ни одной строки.
