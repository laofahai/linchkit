-- Initial migration: LinchKit system tables
-- Generated from packages/core/src/engine/system-tables.ts

CREATE TYPE "_linchkit_execution_status" AS ENUM('succeeded', 'failed', 'rejected');
CREATE TYPE "_linchkit_event_status" AS ENUM('pending', 'processing', 'completed', 'failed');
CREATE TYPE "_linchkit_approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');

CREATE TABLE IF NOT EXISTS "_linchkit_schema_definitions" (
  "name" varchar(255) PRIMARY KEY,
  "label" varchar(255),
  "definition" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "_linchkit_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE IF NOT EXISTS "_linchkit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" varchar(255) NOT NULL,
  "payload" jsonb,
  "source_action" varchar(255),
  "source_execution_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "processed_at" timestamp,
  "status" "_linchkit_event_status" NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS "_linchkit_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "action_name" varchar(255) NOT NULL,
  "input" jsonb,
  "actor_id" varchar(255),
  "status" "_linchkit_approval_status" NOT NULL DEFAULT 'pending',
  "decided_by" varchar(255),
  "decided_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
