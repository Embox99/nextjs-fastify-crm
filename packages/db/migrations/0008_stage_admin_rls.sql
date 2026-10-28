-- Воронки и этапы — настройка workspace. Раньше политики разрешали запись любому участнику,
-- а ограничение держалось только на requirePermission в API. Теперь запись — только scope=all
-- (администраторы и системный контекст); чтение по-прежнему всем участникам workspace.

DROP POLICY pipeline_stages_isolation ON pipeline_stages;
--> statement-breakpoint
CREATE POLICY pipeline_stages_read ON pipeline_stages FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY pipeline_stages_admin ON pipeline_stages FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
--> statement-breakpoint

DROP POLICY pipelines_isolation ON pipelines;
--> statement-breakpoint
CREATE POLICY pipelines_read ON pipelines FOR SELECT
  USING (app.in_workspace(organization_id, workspace_id));
--> statement-breakpoint
CREATE POLICY pipelines_admin ON pipelines FOR ALL
  USING (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all')
  WITH CHECK (app.in_workspace(organization_id, workspace_id) AND app.scope() = 'all');
