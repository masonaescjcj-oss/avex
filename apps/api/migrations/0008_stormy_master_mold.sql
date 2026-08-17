CREATE TYPE "public"."payment_value_source" AS ENUM('quote', 'oracle', 'merchant_rate', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."subscription_charge_status" ADD VALUE 'free_tier';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "value_usd_micros" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "value_source" "payment_value_source";