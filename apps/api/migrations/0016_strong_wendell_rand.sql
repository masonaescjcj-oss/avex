ALTER TABLE "subscription_charges" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "subscription_charges" CASCADE;--> statement-breakpoint
ALTER TABLE "subscriptions" RENAME TO "fee_plans";--> statement-breakpoint
-- Not generated: drizzle does not track the primary-key constraint name, and a table
-- called fee_plans with a constraint called subscriptions_pkey is a trap for whoever
-- next reads a constraint violation.
ALTER INDEX "subscriptions_pkey" RENAME TO "fee_plans_pkey";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP CONSTRAINT "subscriptions_fee_bps_ceiling";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP CONSTRAINT "subscriptions_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "subscriptions_org_key";--> statement-breakpoint
DROP INDEX "subscriptions_status_idx";--> statement-breakpoint
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_plans_org_key" ON "fee_plans" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "price_usd_micros";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "interval_months";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "trial_ends_at";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "grace_ends_at";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "cancel_at_period_end";--> statement-breakpoint
ALTER TABLE "fee_plans" DROP COLUMN "cancelled_at";--> statement-breakpoint
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_fee_bps_ceiling" CHECK ("fee_plans"."fee_bps" between 0 and 500);--> statement-breakpoint
DROP TYPE "public"."subscription_charge_status";--> statement-breakpoint
DROP TYPE "public"."subscription_status";