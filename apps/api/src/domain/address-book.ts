import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { invoices } from '../db/schema.js';

/**
 * Which invoice owns a deposit address.
 *
 * The watcher sees a transfer to an address and has to decide whether it is ours. This is
 * that decision, and it is deliberately the only one it makes: a transfer to an address
 * nobody recognises is ignored, never credited to a guess.
 *
 * Case-insensitive, because the two sides disagree about it and both are right. An EVM
 * address is stored here in EIP-55 mixed case, since that is what a merchant reads and what
 * a wallet shows. An RPC log returns it lowercase. Comparing them literally means every
 * payment on every EVM chain goes unrecognised — which is the failure that looks like the
 * chain being quiet rather than like a bug.
 *
 * Cached, because a busy block asks the same question for the same address many times and
 * the answer cannot change: an invoice's deposit address is derived once and committed to.
 * Only hits are cached — a miss today may be a hit in a minute, when the invoice that owns
 * that address is created.
 */
export class DatabaseAddressBook {
  private readonly hits = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly chain: string,
    /** Bounded so a stream of unknown addresses cannot grow it without limit. */
    private readonly maxCached = 10_000,
  ) {}

  async lookup(address: string): Promise<string | null> {
    const key = address.toLowerCase();
    const cached = this.hits.get(key);
    if (cached !== undefined) return cached;

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
        and(eq(invoices.chain, this.chain), sql`lower(${invoices.depositAddress}) = ${key}`),
      )
      .limit(1);

    if (!row) return null;

    // Evicted wholesale rather than by age: this is a memo, not a cache with a policy, and
    // an LRU here would be more machinery than the problem deserves.
    if (this.hits.size >= this.maxCached) this.hits.clear();
    this.hits.set(key, row.id);
    return row.id;
  }
}
