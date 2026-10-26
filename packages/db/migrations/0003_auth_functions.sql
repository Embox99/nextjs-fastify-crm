-- Аутентификация по паролю (bcrypt через pgcrypto) и список workspace пользователя.
-- Хеш пароля недоступен роли приложения даже на чтение: права выданы поколоночно.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
REVOKE ALL ON users FROM crm_app;
--> statement-breakpoint
GRANT SELECT (id, organization_id, email, full_name, is_active, created_at, updated_at),
      INSERT (id, organization_id, email, full_name, is_active),
      UPDATE (email, full_name, is_active, updated_at)
  ON users TO crm_app;
--> statement-breakpoint

-- organization — slug организации (в B2B обычно поддомен): email уникален только внутри организации.
-- crypt() вычисляется и для несуществующего пользователя (против соли gen_salt) — время ответа
-- не выдаёт, существует ли email.
CREATE FUNCTION app.authenticate(p_organization text, p_email text, p_password text)
RETURNS TABLE (user_id uuid, organization_id uuid, full_name text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH candidate AS (
    SELECT u.id, u.organization_id, u.full_name, u.password_hash
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
    WHERE o.slug = p_organization AND u.email = lower(p_email) AND u.is_active
  )
  SELECT c.id, c.organization_id, c.full_name
  FROM (SELECT 1) AS always
  LEFT JOIN candidate c ON true
  WHERE crypt(p_password, coalesce(c.password_hash, gen_salt('bf', 10))) = c.password_hash
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.authenticate(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.authenticate(text, text, text) TO crm_app;
--> statement-breakpoint

-- Workspace, где пользователь активный участник. user_id обязан прийти из проверенного токена.
CREATE FUNCTION app.user_workspaces(p_user_id uuid)
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.name
  FROM workspace_members wm
  JOIN workspaces w ON w.id = wm.workspace_id
  JOIN users u ON u.id = wm.user_id AND u.is_active
  WHERE wm.user_id = p_user_id
  ORDER BY w.name
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.user_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.user_workspaces(uuid) TO crm_app;
