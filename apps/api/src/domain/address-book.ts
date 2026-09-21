import { addressKey, foldsAddressCase } from '@avex/core';
import type { ChainId } from '@avex/core';
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { depositWallets, invoices } from '../db/schema.js';

/**
 * Whether an address is one of ours.
 *
 * The watcher sees a transfer to an address and has to decide whether it is ours. This is
 * that decision, and it is deliberately the only one it makes: a transfer to an address
 * nobody recognises is ignored, never credited to a guess.
 *
 * "Ours" is two things, and it used to be one. An address an invoice was issued against, and
 * an address the merchant registered as one of their own wallets — a row in `deposit_wallets`
 * that no invoice has been allocated to yet. Only the first counted, and the omission was the
 * quietest bug this project has had: a merchant adds their TRON wallet, sends a little USDT to
 * it to see the thing work, and nothing happens. Not a failed payment, not an unmatched one in
 * the reconciliation queue — nothing anywhere, because the poll's recipient filter was built
 * from the same narrow question and so the node was never even asked about that address.
 * Afterwards the cursor has moved past the block and only `replay-tx` can reach it.
 *
 * A registered wallet with no invoice on it is money that needs a person, not money to be
 * dropped. Saying yes here hands it to the payment sink, which parks it in the reconciliation
 * queue — and `reconsiderParked` attaches it by itself if the matching invoice shows up within
 * the grace window, which covers "paid a moment before the invoice was opened" outright.
 *
 * The two sides disagree about spelling and both are right. An EVM address is stored here in
 * EIP-55 mixed case, since that is what a merchant reads and what a wallet shows. An RPC log
 * returns it lowercase. Comparing them literally means every payment on every EVM chain goes
 * unrecognised — which is the failure that looks like the chain being quiet rather than a bug.
 *
 * Reconciled per chain rather than by lowercasing everything, which is what this did before
 * TRON. Hex folds safely; base58 does not — folding a TRON address yields a string that is not
 * an address, and two distinct valid addresses can fold onto each other, which here would
 * credit a payment to somebody else's invoice. `addressKey` owns that decision.
 *
 */
export class DatabaseAddressBook {
  /** Addresses already recognised. Only hits, for the reason `lookup` gives below. */
  private readonly hits = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly chain: ChainId,
    /** Bounded so a stream of unknown addresses cannot grow it without limit. */
    private readonly maxCached = 10_000,
  ) {}

  /**
   * Whether a transfer to this address is ours — an invoice's address, or a registered wallet.
   *
   * Cached, because a busy block asks the same question for the same address many times.
   * Only hits are cached: a miss today may be a hit in a minute, when the invoice or the
   * wallet that makes it ours is created.
   */
  async recognizes(address: string): Promise<boolean> {
    const key = addressKey(this.chain, address);
    if (this.hits.has(key)) return true;
    if (!(await this.ownsByInvoice(key)) && !(await this.ownsByWallet(key))) return false;
    // Evicted wholesale rather than by age: this is a memo, not a cache with a policy, and
    // an LRU here would be more machinery than the problem deserves.
    if (this.hits.size >= this.maxCached) this.hits.clear();
    this.hits.add(key);
    return true;
  }

  /** The invoice that owns this address, if one does. Used by the sink's own resolution. */
  async lookup(address: string): Promise<string | null> {
    const key = addressKey(this.chain, address);

    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        /**
         * No filter on status, deliberately.
         *
         * An expired or cancelled invoice still owns its deposit address. Money that arrives
         * late is money that arrived: the payer sent it to an address derived for that
         * invoice, it cannot be sent anywhere else, and the address commits to their payout
         * wallet. Refusing to recognise it would leave a real transfer credited to nothing,
         * which is the one outcome worse than crediting it late.
         */
        and(eq(invoices.chain, this.chain), this.matches(invoices.depositAddress, key)),
      )
      .limit(1);

    return row?.id ?? null;
  }

  private async ownsByInvoice(key: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.chain, this.chain), this.matches(invoices.depositAddress, key)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * A wallet the merchant registered, whether or not an invoice has used it.
   *
   * Retired wallets count too. `WalletPoolService.retire` says why in its own words: invoices
   * already pointing at a retired wallet are still open, and a payment arriving there is still
   * the merchant's money. A wallet is only ever removed from the *allocator*, never from the
   * set of addresses worth recognising.
   *
   * No `lower()` here, unlike the invoices column: `register` stores the address through
   * `addressKey`, which is the same function that produced the key, so the two are already in
   * the same form on every chain.
   */
  private async ownsByWallet(key: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: depositWallets.id })
      .from(depositWallets)
      .where(and(eq(depositWallets.chain, this.chain), eq(depositWallets.address, key)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * `lower()` on the column only where the chain says folding is safe.
   *
   * Written as a branch rather than a helper returning SQL because the two arms are different
   * queries: the folded one cannot use an index on the column, the exact one can, and hiding
   * that behind a function would hide it from whoever next reads a slow query log.
   */
  private matches(column: typeof invoices.depositAddress, key: string): SQL | undefined {
    return foldsAddressCase(this.chain) ? sql`lower(${column}) = ${key}` : eq(column, key);
  }

  /**
   * Every deposit address on this chain, so the poll can ask about ours and nobody else's.
   *
   * Asked on every poll and answered from the database every time, deliberately. The set
   * changes whenever an invoice is created — which is exactly when a new address has to be
   * watched — and a cache here would be a cache whose staleness costs a payment.
   *
   * `distinct` is what keeps this small in the shape that matters. A merchant's own wallet
   * is reused by every invoice on it, so a pooled chain collapses to the number of wallets:
   * ten per chain at the most. Forwarder invoices each derive their own address, so a busy
   * EVM chain grows this list one row per invoice, and the poll then asks in batches of a
   * hundred. If that ever becomes the bottleneck, the answer is not a cap here — silently
   * forgetting an address means a real transfer credited to nothing — but a narrower
   * question: the addresses that could still receive, plus a slower sweep for late money.
   *
   * No filter on status, for the same reason `lookup` has none.
   *
   * And the merchants' registered wallets, whether an invoice has used them or not. Without
   * them the node is never asked about a wallet on its first day, so the first transfer to it
   * — which is very often the merchant's own test payment — is not merely unmatched but
   * unseen. `recognizes` says the rest.
   */
  async watched(): Promise<readonly string[]> {
    const [onInvoices, registered] = await Promise.all([
      this.db
        .selectDistinct({ address: invoices.depositAddress })
        .from(invoices)
        .where(eq(invoices.chain, this.chain)),
      this.db
        .selectDistinct({ address: depositWallets.address })
        .from(depositWallets)
        .where(eq(depositWallets.chain, this.chain)),
    ]);

    /**
     * Deduplicated here rather than by a `union` in SQL.
     *
     * A pooled wallet appears in both lists the moment it takes its first invoice, and the
     * poll turns this into a list of log-filter topics — a duplicate would mean asking the
     * node the same question twice and then crediting the same transfer twice on the strength
     * of two identical logs. The sink's identity key would catch that; not generating it is
     * cheaper and clearer.
     */
    const addresses = new Set<string>();
    for (const row of [...onInvoices, ...registered]) {
      if (typeof row.address === 'string' && row.address.length > 0) addresses.add(row.address);
    }
    return [...addresses];
  }
}
