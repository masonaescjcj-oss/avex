DROP INDEX "invoices_org_reference_key";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reference_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "invoices" SET "reference_active" = false WHERE "status" = 'expired';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_reference_key" ON "invoices" USING btree ("organization_id","reference") WHERE "invoices"."reference" is not null and "invoices"."reference_active";
