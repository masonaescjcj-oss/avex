DROP INDEX "checkout_sessions_org_reference_key";--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "reference_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "checkout_sessions" SET "reference_active" = false WHERE "status" in ('expired', 'cancelled') or ("status" in ('open', 'selected') and "expires_at" <= now());--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_org_reference_key" ON "checkout_sessions" USING btree ("organization_id","reference") WHERE "checkout_sessions"."reference" is not null and "checkout_sessions"."reference_active";
