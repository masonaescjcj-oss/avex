DROP INDEX "invoices_chain_memo_idx";--> statement-breakpoint
DROP INDEX "invoices_chain_deposit_key";--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_chain_memo_key" ON "invoices" USING btree ("chain","memo") WHERE "invoices"."memo" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_chain_deposit_key" ON "invoices" USING btree ("chain","deposit_address") WHERE "invoices"."memo" is null;