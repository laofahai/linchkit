CREATE TYPE "_linchkit"."overlay_status" AS ENUM('active', 'deprecated', 'promoted');--> statement-breakpoint
CREATE TABLE "_linchkit"."field_overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_name" text NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposal_id" uuid,
	"status" "_linchkit"."overlay_status" DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN "_extensions" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_item" ADD COLUMN "_extensions" jsonb;--> statement-breakpoint
ALTER TABLE "purchase_request" ADD COLUMN "_extensions" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_field_overlays_entity_field" ON "_linchkit"."field_overlays" USING btree ("entity_name","field_name");