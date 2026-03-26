CREATE SCHEMA "_linchkit";
--> statement-breakpoint
CREATE TYPE "_linchkit"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "_linchkit"."event_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "_linchkit"."execution_status" AS ENUM('succeeded', 'failed', 'blocked', 'pending_approval');--> statement-breakpoint
CREATE TABLE "_linchkit"."approvals" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(255),
	"action_name" varchar(255) NOT NULL,
	"schema_name" varchar(255),
	"record_id" varchar(255),
	"capability" varchar(255),
	"input" jsonb,
	"level" varchar(100) NOT NULL,
	"reason" text NOT NULL,
	"trigger_rules" jsonb,
	"actor_id" varchar(255),
	"actor_type" varchar(50),
	"assignee_type" varchar(50) NOT NULL,
	"assignee_value" varchar(255) NOT NULL,
	"status" "_linchkit"."approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" varchar(255),
	"decided_at" timestamp,
	"decision_note" text,
	"expires_at" timestamp,
	"timeout_policy" varchar(50) DEFAULT 'reject' NOT NULL,
	"original_execution_id" varchar(255),
	"execution_id" varchar(255),
	"execution_error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(128),
	"updated_by" varchar(128),
	"_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(255) NOT NULL,
	"manager" varchar(255),
	"budget_limit" numeric,
	CONSTRAINT "department_name_unique" UNIQUE("name"),
	CONSTRAINT "department_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "_linchkit"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(255),
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb,
	"source_action" varchar(255),
	"source_execution_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"status" "_linchkit"."event_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "_linchkit"."executions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(255),
	"action_name" varchar(255) NOT NULL,
	"schema_name" varchar(255),
	"record_id" varchar(255),
	"capability" varchar(255),
	"input" jsonb,
	"output" jsonb,
	"actor_id" varchar(255),
	"actor_type" varchar(50),
	"status" "_linchkit"."execution_status" NOT NULL,
	"error_code" varchar(100),
	"error_message" text,
	"duration_ms" integer,
	"channel" varchar(50),
	"parent_execution_id" varchar(255),
	"idempotency_key" varchar(255),
	"metadata" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_item" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(128),
	"updated_by" varchar(128),
	"_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"quantity" numeric NOT NULL,
	"unit_price" numeric NOT NULL,
	"specification" text
);
--> statement-breakpoint
CREATE TABLE "purchase_request" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(128),
	"updated_by" varchar(128),
	"_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(255) NOT NULL,
	"description" text,
	"amount" numeric NOT NULL,
	"requester" varchar(255),
	"requester_email" varchar(255),
	"status" varchar(50) DEFAULT 'draft',
	"priority" varchar(50),
	"notes" text,
	"audit_notes" text,
	"submitted_at" timestamp,
	"approved_at" timestamp,
	"approved_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX "idx_events_type_status" ON "_linchkit"."events" USING btree ("event_type","status");--> statement-breakpoint
CREATE INDEX "idx_events_retry" ON "_linchkit"."events" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "idx_events_tenant" ON "_linchkit"."events" USING btree ("tenant_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_executions_action_created" ON "_linchkit"."executions" USING btree ("action_name","created_at");--> statement-breakpoint
CREATE INDEX "idx_executions_tenant" ON "_linchkit"."executions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_executions_idempotency_key" ON "_linchkit"."executions" USING btree ("tenant_id","idempotency_key");