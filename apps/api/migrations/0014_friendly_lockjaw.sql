CREATE TYPE "public"."object_mode" AS ENUM('test', 'live');--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "mode" "object_mode" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "mode" "object_mode" DEFAULT 'live' NOT NULL;--> statement-breakpoint
CREATE INDEX "invoices_org_mode_idx" ON "invoices" USING btree ("organization_id","mode");