CREATE TYPE "public"."pricing_mode" AS ENUM('fiat', 'token', 'fixed_rate');--> statement-breakpoint
CREATE TABLE "price_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"source" text NOT NULL,
	"price_scaled" numeric(78, 0),
	"observed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"asset_contract" text,
	"asset_decimals" text NOT NULL,
	"mode" "pricing_mode" NOT NULL,
	"amount_due" numeric(78, 0) NOT NULL,
	"market_rate_scaled" numeric(78, 0),
	"effective_rate_scaled" numeric(78, 0),
	"spread_bps" text NOT NULL,
	"amount_fiat_micros" numeric(78, 0),
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_ticks_symbol_created_idx" ON "price_ticks" USING btree ("symbol","created_at");--> statement-breakpoint
CREATE INDEX "quotes_org_created_idx" ON "quotes" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "quotes_expires_idx" ON "quotes" USING btree ("expires_at");