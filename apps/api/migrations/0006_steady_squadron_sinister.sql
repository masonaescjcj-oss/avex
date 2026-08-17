CREATE TYPE "public"."settlement_status" AS ENUM('pending', 'confirmed', 'reverted', 'replaced');--> statement-breakpoint
CREATE TYPE "public"."unmatched_reason" AS ENUM('no_matching_address', 'memo_missing', 'wrong_asset', 'invoice_expired', 'below_minimum');--> statement-breakpoint
CREATE TYPE "public"."unmatched_resolution" AS ENUM('pending', 'attached', 'returned', 'ignored');--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"tx_hash" text NOT NULL,
	"nonce" integer NOT NULL,
	"invoice_ids" jsonb NOT NULL,
	"fee_per_gas_wei" numeric(78, 0) NOT NULL,
	"gas_limit" numeric(78, 0) NOT NULL,
	"gas_used" numeric(78, 0),
	"estimated_cost_usd_micros" numeric(78, 0),
	"actual_cost_usd_micros" numeric(78, 0),
	"status" "settlement_status" DEFAULT 'pending' NOT NULL,
	"replaced_by_tx_hash" text,
	"broadcast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "unmatched_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"tx_hash" text NOT NULL,
	"transfer_index" integer NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"asset_id" uuid,
	"contract" text,
	"to_address" text NOT NULL,
	"from_address" text,
	"memo" text,
	"block_number" integer NOT NULL,
	"reason" "unmatched_reason" NOT NULL,
	"resolution" "unmatched_resolution" DEFAULT 'pending' NOT NULL,
	"attached_invoice_id" uuid,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"note" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "reviewed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "unmatched_payments" ADD CONSTRAINT "unmatched_payments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_payments" ADD CONSTRAINT "unmatched_payments_attached_invoice_id_invoices_id_fk" FOREIGN KEY ("attached_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_payments" ADD CONSTRAINT "unmatched_payments_resolved_by_staff_id_staff_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_chain_tx_key" ON "settlements" USING btree ("chain","tx_hash");--> statement-breakpoint
CREATE INDEX "settlements_chain_status_idx" ON "settlements" USING btree ("chain","status");--> statement-breakpoint
CREATE INDEX "settlements_chain_nonce_idx" ON "settlements" USING btree ("chain","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_identity_key" ON "unmatched_payments" USING btree ("chain","tx_hash","transfer_index");--> statement-breakpoint
CREATE INDEX "unmatched_resolution_idx" ON "unmatched_payments" USING btree ("resolution","seen_at");--> statement-breakpoint
CREATE INDEX "unmatched_to_address_idx" ON "unmatched_payments" USING btree ("chain","to_address");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_reviewed_by_staff_id_staff_id_fk" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;