CREATE TYPE "public"."checkout_session_status" AS ENUM('open', 'selected', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reference" text,
	"amount_fiat_micros" numeric(78, 0) NOT NULL,
	"description" text,
	"status" "checkout_session_status" DEFAULT 'open' NOT NULL,
	"invoice_id" uuid,
	"success_url" text,
	"cancel_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"selected_at" timestamp with time zone,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_sessions_org_created_idx" ON "checkout_sessions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "checkout_sessions_status_idx" ON "checkout_sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_org_reference_key" ON "checkout_sessions" USING btree ("organization_id","reference") WHERE "checkout_sessions"."reference" is not null;