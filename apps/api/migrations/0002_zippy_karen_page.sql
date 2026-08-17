CREATE TYPE "public"."asset_kind" AS ENUM('native', 'erc20', 'trc20', 'spl', 'jetton');--> statement-breakpoint
CREATE TYPE "public"."asset_verdict" AS ENUM('blocked', 'review', 'approved');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"symbol" text NOT NULL,
	"contract" text,
	"decimals" integer NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"curated" boolean DEFAULT false NOT NULL,
	"verdict" "asset_verdict" NOT NULL,
	"requires_fixed_rate" boolean DEFAULT false NOT NULL,
	"findings" jsonb,
	"probed_at" timestamp with time zone,
	"submitted_by_organization_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"pricing_mode" "pricing_mode" NOT NULL,
	"fixed_rate_scaled" numeric(78, 0),
	"fixed_rate_valid_until" timestamp with time zone,
	"spread_bps" integer DEFAULT 50 NOT NULL,
	"tolerance_bps" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_submitted_by_organization_id_organizations_id_fk" FOREIGN KEY ("submitted_by_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_assets" ADD CONSTRAINT "merchant_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_assets" ADD CONSTRAINT "merchant_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_chain_contract_key" ON "assets" USING btree ("chain","contract");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_chain_native_key" ON "assets" USING btree ("chain") WHERE "assets"."contract" is null;--> statement-breakpoint
CREATE INDEX "assets_verdict_idx" ON "assets" USING btree ("verdict");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_assets_org_asset_key" ON "merchant_assets" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX "merchant_assets_org_idx" ON "merchant_assets" USING btree ("organization_id");