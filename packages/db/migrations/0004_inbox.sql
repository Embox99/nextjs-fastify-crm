CREATE TYPE "public"."channel_kind" AS ENUM('website_form', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('received', 'pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbound_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."merge_status" AS ENUM('open', 'merged', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"name" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"previous_webhook_secret" text,
	"outbound_token" text,
	"default_pipeline_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_ws_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_thread_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"deal_id" uuid,
	"assignee_id" uuid,
	"team_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_ws_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "conversations_channel_thread_uq" UNIQUE("channel_id","external_thread_id")
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "inbound_status" DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_events_channel_external_uq" UNIQUE("channel_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "merge_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_ids" uuid[] NOT NULL,
	"reason" text NOT NULL,
	"status" "merge_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_candidates_ws_contacts_uq" UNIQUE("workspace_id","contact_ids")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text NOT NULL,
	"external_id" text,
	"author_id" uuid,
	"delivery_status" "delivery_status" NOT NULL,
	"delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_external_uq" UNIQUE("conversation_id","direction","external_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_workspace_id_workspaces_organization_id_id_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."workspaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_default_pipeline_id_pipelines_workspace_id_id_fk" FOREIGN KEY ("workspace_id","default_pipeline_id") REFERENCES "public"."pipelines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_workspace_id_workspaces_organization_id_id_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."workspaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_channel_id_channels_workspace_id_id_fk" FOREIGN KEY ("workspace_id","channel_id") REFERENCES "public"."channels"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_contact_id_contacts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."contacts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_deal_id_deals_workspace_id_id_fk" FOREIGN KEY ("workspace_id","deal_id") REFERENCES "public"."deals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_team_id_teams_workspace_id_id_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_assignee_id_users_organization_id_id_fk" FOREIGN KEY ("organization_id","assignee_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_workspace_id_workspaces_organization_id_id_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."workspaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_workspace_id_channel_id_channels_workspace_id_id_fk" FOREIGN KEY ("workspace_id","channel_id") REFERENCES "public"."channels"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_candidates" ADD CONSTRAINT "merge_candidates_organization_id_workspace_id_workspaces_organization_id_id_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."workspaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_workspace_id_workspaces_organization_id_id_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "public"."workspaces"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_conversation_id_conversations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_author_id_users_organization_id_id_fk" FOREIGN KEY ("organization_id","author_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "conversations" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "inbound_events_pending_idx" ON "inbound_events" USING btree ("received_at") WHERE status = 'received';--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");