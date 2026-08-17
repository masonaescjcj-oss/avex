CREATE TABLE "payout_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"pending_change_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_pending_change_id_pending_changes_id_fk" FOREIGN KEY ("pending_change_id") REFERENCES "public"."pending_changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_addresses_active_key" ON "payout_addresses" USING btree ("organization_id","chain") WHERE "payout_addresses"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "payout_addresses_org_idx" ON "payout_addresses" USING btree ("organization_id");