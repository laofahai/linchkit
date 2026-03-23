CREATE TYPE "public"."_linchkit_approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."_linchkit_event_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."_linchkit_execution_status" AS ENUM('succeeded', 'failed', 'rejected');--> statement-breakpoint
CREATE TABLE "_linchkit_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_name" varchar(255) NOT NULL,
	"input" jsonb,
	"actor_id" varchar(255),
	"status" "_linchkit_approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" varchar(255),
	"decided_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_linchkit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb,
	"source_action" varchar(255),
	"source_execution_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"status" "_linchkit_event_status" DEFAULT 'pending' NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "_linchkit_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_name" varchar(255) NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"actor_id" varchar(255),
	"actor_type" varchar(50),
	"status" "_linchkit_execution_status" NOT NULL,
	"error_code" varchar(100),
	"error_message" text,
	"duration_ms" integer,
	"channel" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"department" varchar(255),
	"requester" varchar(255),
	"status" varchar(50) DEFAULT 'draft',
	"priority" varchar(50),
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "idx_events_type_status" ON "_linchkit_events" USING btree ("event_type","status");--> statement-breakpoint
CREATE INDEX "idx_executions_action_created" ON "_linchkit_executions" USING btree ("action_name","created_at");