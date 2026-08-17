CREATE TYPE "public"."subscription_charge_status" AS ENUM('due', 'paid', 'waived');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'unpaid', 'cancelled');--> statement-breakpoint
CREATE TABLE "subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_usd_micros" numeric(78, 0) NOT NULL,
	"status" "subscription_charge_status" DEFAULT 'due' NOT NULL,
	"invoice_id" uuid,
	"external_reference" text,
	"paid_at" timestamp with time zone,
	"waived_by_staff_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"price_usd_micros" numeric(78, 0) NOT NULL,
	"interval_months" integer DEFAULT 1 NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_waived_by_staff_id_staff_id_fk" FOREIGN KEY ("waived_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_charges_period_key" ON "subscription_charges" USING btree ("subscription_id","period_start");--> statement-breakpoint
CREATE INDEX "subscription_charges_org_status_idx" ON "subscription_charges" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_key" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");