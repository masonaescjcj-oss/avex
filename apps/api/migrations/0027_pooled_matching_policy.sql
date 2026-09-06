ALTER TYPE "public"."unmatched_reason" ADD VALUE 'ambiguous';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "credited_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "asset_symbol" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "asset_contract" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "asset_decimals" integer;