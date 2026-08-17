ALTER TABLE "invoices" ADD COLUMN "fee_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fee_destination" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fee_bps_ceiling" CHECK ("invoices"."fee_bps" between 0 and 500);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fee_has_destination" CHECK ("invoices"."fee_bps" = 0 or "invoices"."fee_destination" is not null);