# Lead-to-Deal Engine

CRM для сервисного B2B: лиды → сделки, омниканальный инбокс, движок автоматизаций.
Архитектура и решения — в [docs/DESIGN.md](docs/DESIGN.md).

## Состояние

| Неделя | Что готово |
|---|---|
| 1 | Монорепо (pnpm + Turborepo), Docker Compose, Drizzle-схема, RLS-изоляция и видимость `all/team/own`, `withRls`, аудит-триггер, RBAC-матрица интеграционных тестов |

## Быстрый старт

Нужны Node 24+, Docker и pnpm (`corepack enable`).

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres :5434, Redis :6380
pnpm db:migrate     # под владельцем схемы (MIGRATION_DATABASE_URL)
pnpm test           # поднимает свой Postgres через Testcontainers
```

## Структура

```
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
