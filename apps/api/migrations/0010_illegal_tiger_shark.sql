ALTER TABLE "subscriptions" ADD COLUMN "fee_bps" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "negotiated_fee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_fee_bps_ceiling" CHECK ("subscriptions"."fee_bps" between 0 and 500);