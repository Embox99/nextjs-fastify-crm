-- RLS и служебные функции движка автоматизаций.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events', 'automations', 'automation_runs', 'assignment_pools',
                           'assignment_pool_members', 'notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- Identity-колонка outbox_events: вставка от имени приложения берёт значения из последовательности
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO crm_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO crm_app;
--> statement-breakpoint

-- Outbox: событие пишет любой, кто меняет данные своего workspace; читает и публикует — только система
CREATE POLICY outbox_insert ON outbox_events FOR INSERT
  WITH CHECK (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY outbox_system ON outbox_events FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Автоматизации и их запуски — настройка workspace: только scope=all (админы и система)
CREATE POLICY automations_admin ON automations FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint
CREATE POLICY automation_runs_admin ON automation_runs FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Пулы видны участникам workspace (кто в ротации), меняет их только scope=all
CREATE POLICY assignment_pools_read ON assignment_pools FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY assignment_pools_write ON assignment_pools FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint
CREATE POLICY assignment_pool_members_read ON assignment_pool_members FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY assignment_pool_members_write ON assignment_pool_members FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Уведомления: пользователь видит и отмечает прочитанными только свои (даже администратор).
-- Системный контекст (user_id не задан) создаёт их и читает результат INSERT ... RETURNING.
CREATE POLICY notifications_own ON notifications FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id)
         AND (user_id = app.user_id() OR (app.user_id() IS NULL AND app.scope() = 'all')));
--> statement-breakpoint
CREATE POLICY notifications_own_update ON notifications FOR UPDATE
  USING (app.in_workspace(organization_id, workspace_id) AND user_id = app.user_id())
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND user_id = app.user_id());
--> statement-breakpoint
CREATE POLICY notifications_system_insert ON notifications FOR INSERT
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Relay забирает пачку неопубликованных событий всех workspace. SKIP LOCKED: несколько relay
-- не берут одно событие. Вызывать внутри транзакции: если постановка в очередь упадёт,
-- откат вернёт published_at в NULL и событие уйдёт со следующей пачкой.
CREATE FUNCTION app.claim_outbox(p_limit int)
RETURNS SETOF outbox_events
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH batch AS (
    SELECT id FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_events o SET published_at = now()
  FROM batch WHERE o.id = batch.id
  RETURNING o.*
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_outbox(int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_outbox(int) TO crm_app;
--> statement-breakpoint

-- Сканер «нет активности N дней» обходит включённые автоматизации всех workspace
CREATE FUNCTION app.enabled_automations_by_trigger(p_trigger_type text)
RETURNS TABLE (id uuid, organization_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.organization_id, a.workspace_id FROM automations a
  WHERE a.enabled AND a.trigger_type = p_trigger_type
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enabled_automations_by_trigger(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enabled_automations_by_trigger(text) TO crm_app;
