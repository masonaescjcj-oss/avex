CREATE TYPE "public"."fee_payer" AS ENUM('merchant', 'payer');--> statement-breakpoint
ALTER TABLE "fee_plans" ADD COLUMN "fee_payer" "fee_payer" DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fee_payer" "fee_payer" DEFAULT 'merchant' NOT NULL;