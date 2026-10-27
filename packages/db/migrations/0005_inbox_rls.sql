-- RLS и права для инбокса и приёма лидов.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels', 'inbound_events', 'conversations', 'messages', 'merge_candidates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Секреты каналов роль приложения не читает: только поколоночные права без секретных колонок.
-- Запись разрешена (создание канала, ротация), чтение — через функции ниже.
REVOKE ALL ON channels FROM crm_app;
--> statement-breakpoint
GRANT SELECT (id, organization_id, workspace_id, kind, name, default_pipeline_id, enabled, created_at, updated_at),
      INSERT,
      UPDATE (name, enabled, default_pipeline_id, webhook_secret, previous_webhook_secret, outbound_token, updated_at),
      DELETE
  ON channels TO crm_app;
--> statement-breakpoint

CREATE POLICY channels_read ON channels FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY channels_admin_insert ON channels FOR INSERT
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint
CREATE POLICY channels_admin_update ON channels FOR UPDATE
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint
CREATE POLICY channels_admin_delete ON channels FOR DELETE
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Публичный webhook-эндпоинт ещё не знает тенанта: канал определяется по id из URL.
-- Возвращает зашифрованные секреты — без ключа шифрования (он вне БД) они бесполезны.
CREATE FUNCTION app.webhook_channel(p_channel_id uuid)
RETURNS TABLE (organization_id uuid, workspace_id uuid, kind text, enabled boolean,
               webhook_secret text, previous_webhook_secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.organization_id, c.workspace_id, c.kind::text, c.enabled, c.webhook_secret, c.previous_webhook_secret
  FROM channels c WHERE c.id = p_channel_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.webhook_channel(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.webhook_channel(uuid) TO crm_app;
--> statement-breakpoint

-- Токен исходящих сообщений — только для канала текущего workspace (контекст обязан быть выставлен)
CREATE FUNCTION app.channel_outbound_token(p_channel_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.outbound_token FROM channels c
  WHERE c.id = p_channel_id AND c.organization_id = app.org_id() AND c.workspace_id = app.workspace_id()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.channel_outbound_token(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.channel_outbound_token(uuid) TO crm_app;
--> statement-breakpoint

-- Сырые события и задачи на слияние — служебные данные: только scope=all (админы и системный контекст)
CREATE POLICY inbound_events_admin ON inbound_events FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint
CREATE POLICY merge_candidates_admin ON merge_candidates FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

-- Диалог виден так же, как сделка: ответственному, лиду его команды, админу
CREATE POLICY conversations_visibility ON conversations FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.owner_visible(assignee_id, team_id))
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.owner_visible(assignee_id, team_id));
--> statement-breakpoint
-- Видимый диалог подразумевает видимый контакт: иначе ответственный за диалог без сделки
-- не увидел бы собеседника. Рекурсии нет — политика conversations не ссылается на contacts.
DROP POLICY contacts_visibility ON contacts;
--> statement-breakpoint
CREATE POLICY contacts_visibility ON contacts FOR ALL
  USING (
    app.in_workspace(organization_id, workspace_id)
    AND ((SELECT app.scope()) = 'all'
         OR owner_id = (SELECT app.user_id())
         OR EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = contacts.id)
         OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = contacts.id))
  )
  WITH CHECK (
    app.in_workspace(organization_id, workspace_id)
    AND ((SELECT app.scope()) = 'all'
         OR owner_id = (SELECT app.user_id())
         OR EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = contacts.id)
         OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = contacts.id))
  );
--> statement-breakpoint
CREATE POLICY messages_visibility ON messages FOR ALL
  USING (app.in_workspace(organization_id, workspace_id)
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id))
  WITH CHECK (app.in_workspace(organization_id, workspace_id)
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id));
--> statement-breakpoint

-- Sweeper воркера ищет «застрявшие» события во всех workspace сразу — RLS видит только один.
-- Функция отдаёт лишь координаты события (id + тенант), не payload.
CREATE FUNCTION app.stale_inbound_events(p_older_than interval, p_limit int)
RETURNS TABLE (id uuid, organization_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.organization_id, e.workspace_id
  FROM inbound_events e
  WHERE e.status = 'received' AND e.received_at < now() - p_older_than
  ORDER BY e.received_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.stale_inbound_events(interval, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.stale_inbound_events(interval, int) TO crm_app;
