CREATE TYPE "public"."address_model" AS ENUM('unique', 'pooled', 'shared-memo');--> statement-breakpoint
DROP INDEX "invoices_chain_deposit_key";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "address_model" "address_model" DEFAULT 'unique' NOT NULL;--> statement-breakpoint
-- Every invoice that exists was created when the model was a property of the chain: TRON was
-- the one pooled chain, and a memo meant TON's shared wallet. Written onto the rows before the
-- index is rebuilt, or the rebuild would find TRON's shared-address invoices violating it.
UPDATE "invoices" SET "address_model" = 'pooled' WHERE "chain" = 'tron';--> statement-breakpoint
UPDATE "invoices" SET "address_model" = 'shared-memo' WHERE "memo" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_chain_deposit_key" ON "invoices" USING btree ("chain","deposit_address") WHERE "invoices"."address_model" = 'unique';