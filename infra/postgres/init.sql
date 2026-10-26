-- Выполняется один раз при создании тома. Только для локальной разработки:
-- в проде логин-роль и пароль создаёт инфраструктура (Terraform/секреты), а не репозиторий.
create role crm_app nologin;
create role crm_app_user login password 'crm_app_user' in role crm_app;
