-- Row Level Security: изоляция тенантов и иерархическая видимость (all / team / own).
-- Контекст приходит из transaction-local GUC, которые выставляет withRls().
-- Каждый statement отделён breakpoint'ом: мигратор drizzle выполняет их по одному.

-- 1. Роль приложения. Логин-роль (crm_app_user) входит в неё; BYPASSRLS нет ни у одной из них.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app, public TO crm_app;
--> statement-breakpoint

-- 2. Функции чтения контекста. Все — однострочные STABLE SQL без подзапросов: планировщик их инлайнит,
--    и предикат превращается в `workspace_id = nullif(current_setting(...))::uuid` — стабильное
--    выражение, пригодное для Index Cond. Подзапрос (SELECT ...) внутри тела запретил бы инлайнинг,
--    и функция вызывалась бы на каждую строку.
CREATE FUNCTION app.org_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app.scope() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('app.scope', true), ''), 'own') $$;
--> statement-breakpoint
CREATE FUNCTION app.team_ids() RETURNS uuid[] LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('app.team_ids', true), ''), '{}')::uuid[] $$;
--> statement-breakpoint

-- Предикаты политик (тоже инлайнятся — тест проверяет план запроса).
CREATE FUNCTION app.in_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT p_org = app.org_id() $$;
--> statement-breakpoint
CREATE FUNCTION app.in_workspace(p_org uuid, p_ws uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT p_org = app.org_id() AND p_ws = app.workspace_id() $$;
--> statement-breakpoint
CREATE FUNCTION app.owner_visible(p_owner uuid, p_team uuid) RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT app.scope() = 'all'
         OR (app.scope() = 'team' AND p_team = ANY (app.team_ids()))
         OR p_owner = app.user_id() $$;
--> statement-breakpoint

-- 3. Сборка контекста по membership. SECURITY DEFINER: читает таблицы прав в обход RLS,
--    поэтому владелец схемы должен иметь BYPASSRLS. userId обязан прийти из проверенной сессии.
CREATE FUNCTION app.resolve_auth_context(p_user_id uuid, p_workspace_id uuid)
RETURNS TABLE (organization_id uuid, scope text, team_ids uuid[], permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH RECURSIVE membership AS (
    SELECT w.organization_id, r.id AS role_id, r.scope::text AS scope
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    JOIN users u ON u.id = wm.user_id AND u.is_active
    JOIN roles r ON r.id = wm.role_id
    WHERE wm.user_id = p_user_id AND wm.workspace_id = p_workspace_id
  ),
  led_teams(id) AS (
    SELECT tm.team_id FROM team_members tm
    WHERE tm.user_id = p_user_id AND tm.workspace_id = p_workspace_id AND tm.is_lead
    UNION
    SELECT t.id FROM teams t JOIN led_teams lt ON t.parent_team_id = lt.id
  )
  SELECT m.organization_id,
         m.scope,
         coalesce((SELECT array_agg(id ORDER BY id) FROM led_teams), '{}'),
         coalesce((SELECT array_agg(rp.permission ORDER BY rp.permission)
                   FROM role_permissions rp WHERE rp.role_id = m.role_id), '{}')
  FROM membership m
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resolve_auth_context(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_auth_context(uuid, uuid) TO crm_app;
--> statement-breakpoint

-- 4. Audit log: партиционирован по месяцам, пишется только триггером.
CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  organization_id uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  actor_id        uuid,
  entity          text NOT NULL,
  entity_id       uuid NOT NULL,
  action          text NOT NULL,
  diff            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
-- Default-партиция страхует вставку; помесячные партиции нарезает pg_partman / cron (неделя 4).
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
--> statement-breakpoint
CREATE INDEX audit_logs_entity_idx ON audit_logs (workspace_id, entity, entity_id, created_at);
--> statement-breakpoint
CREATE FUNCTION app.audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  changes jsonb;
BEGIN
  IF tg_op = 'DELETE' THEN r := old; ELSE r := new; END IF;

  IF tg_op = 'UPDATE' THEN
    SELECT jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) INTO changes
    FROM jsonb_each(to_jsonb(new)) n
    JOIN jsonb_each(to_jsonb(old)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('updated_at', 'version');
    IF changes IS NULL THEN RETURN new; END IF;
  ELSE
    changes := to_jsonb(r);
  END IF;

  INSERT INTO audit_logs (organization_id, workspace_id, actor_id, entity, entity_id, action, diff)
  VALUES (r.organization_id, r.workspace_id, app.user_id(), tg_table_name, r.id, lower(tg_op), changes);
  RETURN r;
END $$;
--> statement-breakpoint
CREATE TRIGGER deals_audit AFTER INSERT OR UPDATE OR DELETE ON deals
  FOR EACH ROW EXECUTE FUNCTION app.audit();
--> statement-breakpoint
CREATE TRIGGER contacts_audit AFTER INSERT OR UPDATE OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.audit();
--> statement-breakpoint

-- 5. Права на таблицы. Будущие таблицы получат права автоматически — а тест проверит, что у них есть RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON organizations FROM crm_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM crm_app;
--> statement-breakpoint
REVOKE ALL ON audit_logs_default FROM crm_app;
--> statement-breakpoint

-- 6. Включение RLS. FORCE — чтобы политики действовали и на владельца таблицы без BYPASSRLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'workspaces', 'users', 'roles', 'role_permissions', 'workspace_members',
    'teams', 'team_members', 'pipelines', 'pipeline_stages', 'contacts', 'contact_identities',
    'deals', 'activities', 'audit_logs', 'audit_logs_default'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 7. Политики.
-- Уровень организации
CREATE POLICY organizations_isolation ON organizations FOR SELECT USING (id = app.org_id());
--> statement-breakpoint
CREATE POLICY workspaces_isolation ON workspaces FOR ALL
  USING (app.in_org(organization_id)) WITH CHECK (app.in_org(organization_id));
--> statement-breakpoint
CREATE POLICY users_isolation ON users FOR ALL
  USING (app.in_org(organization_id)) WITH CHECK (app.in_org(organization_id));
--> statement-breakpoint
CREATE POLICY roles_isolation ON roles FOR ALL
  USING (app.in_org(organization_id)) WITH CHECK (app.in_org(organization_id));
--> statement-breakpoint
CREATE POLICY role_permissions_isolation ON role_permissions FOR ALL
  USING (app.in_org(organization_id)) WITH CHECK (app.in_org(organization_id));
--> statement-breakpoint

-- Уровень workspace: справочники видны всем участникам, права на запись — на уровне приложения
CREATE POLICY workspace_members_isolation ON workspace_members FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)) WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY teams_isolation ON teams FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)) WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY team_members_isolation ON team_members FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)) WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY pipelines_isolation ON pipelines FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)) WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY pipeline_stages_isolation ON pipeline_stages FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)) WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint

-- Сделки: один предикат на чтение и запись. WITH CHECK не даёт вывести строку из своей зоны
-- (реп не может переназначить сделку на коллегу, лид — увести её в чужую команду).
CREATE POLICY deals_visibility ON deals FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.owner_visible(owner_id, team_id))
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.owner_visible(owner_id, team_id));
--> statement-breakpoint

-- Контакты: свои, scope=all, или привязанные к видимой сделке (подзапрос сам проходит через RLS deals)
CREATE POLICY contacts_visibility ON contacts FOR ALL
  USING (
    app.in_workspace(organization_id, workspace_id)
    AND ((SELECT app.scope()) = 'all'
         OR owner_id = (SELECT app.user_id())
         OR EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = contacts.id))
  )
  WITH CHECK (
    app.in_workspace(organization_id, workspace_id)
    AND ((SELECT app.scope()) = 'all'
         OR owner_id = (SELECT app.user_id())
         OR EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = contacts.id))
  );
--> statement-breakpoint
CREATE POLICY contact_identities_visibility ON contact_identities FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)
         AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identities.contact_id))
  WITH CHECK (app.in_workspace(organization_id, workspace_id)
         AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_identities.contact_id));
--> statement-breakpoint

-- Активности наследуют видимость сделки, иначе контакта, иначе автора
CREATE POLICY activities_visibility ON activities FOR ALL
  USING (
    app.in_workspace(organization_id, workspace_id)
    AND CASE
      WHEN deal_id IS NOT NULL THEN EXISTS (SELECT 1 FROM deals d WHERE d.id = activities.deal_id)
      WHEN contact_id IS NOT NULL THEN EXISTS (SELECT 1 FROM contacts c WHERE c.id = activities.contact_id)
      ELSE (SELECT app.scope()) = 'all' OR author_id = (SELECT app.user_id())
    END
  )
  WITH CHECK (
    app.in_workspace(organization_id, workspace_id)
    AND CASE
      WHEN deal_id IS NOT NULL THEN EXISTS (SELECT 1 FROM deals d WHERE d.id = activities.deal_id)
      WHEN contact_id IS NOT NULL THEN EXISTS (SELECT 1 FROM contacts c WHERE c.id = activities.contact_id)
      ELSE (SELECT app.scope()) = 'all' OR author_id = (SELECT app.user_id())
    END
  );
--> statement-breakpoint

-- Аудит читают только администраторы workspace; политики на запись нет вовсе
CREATE POLICY audit_logs_read ON audit_logs FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id) AND (SELECT app.scope()) = 'all');
