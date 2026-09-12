CREATE TABLE "telegram_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"username" text NOT NULL,
	"token_sealed" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"forward_url" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_update_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bots_org_key" ON "telegram_bots" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bots_bot_key" ON "telegram_bots" USING btree ("bot_id");