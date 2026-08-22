import { addressKey } from '@avex/core';
import type { ChainId } from '@avex/core';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { depositWallets, invoices } from '../db/schema.js';
import { WalletPoolError, chooseAmount, chooseWallet } from './wallet-pool-allocator.js';
import type { WalletLoad } from './wallet-pool-allocator.js';

/**
 * The merchant's wallet pool, and the allocation an invoice on a pooled chain needs.
 *
 * The allocator decides; this reads the state it decides from and makes the decision stick.
 * Which is the harder half, because both halves of an allocation have to be unique against
 * invoices that other requests are creating at the same moment: two invoices given the same
 * amount on the same wallet are indistinguishable forever afterwards, and no reconciliation
 * rule — automatic or human — can tell whose payment is whose.
 *
 * ## Why a lock rather than a retry
 *
 * The obvious approach is optimistic: read the open amounts, pick one, insert, and catch the
 * unique-constraint violation. It does not work here, because there is no constraint to
 * violate. "No two *open* invoices on one address share an amount" is a condition over a
 * subset of rows that changes as invoices are paid and expire, and a partial unique index
 * cannot express it — `status in ('pending','confirming')` is not immutable, so Postgres will
 * not index on it.
 *
 * So the uniqueness is enforced by serialising allocations per (organisation, chain) with a
 * transaction-scoped advisory lock. It is a narrow lock: two merchants never wait for each
 * other, and neither do two chains of one merchant. What waits is a second invoice for the same
 * merchant on the same chain, for the length of one insert.
 */

/** What an invoice on a pooled chain is allocated. */
export interface PoolAllocation {
  readonly walletId: string;
  readonly address: string;
  /**
   * The amount the payer must send, in smallest units — the merchant's price plus the
   * disambiguator. This is what goes in `invoices.amount_due`, because it is what "paid in
   * full" means for this invoice.
   */
  readonly amountDue: bigint;
}

/** Statuses that make an invoice's amount unavailable for reuse on its wallet. */
const OPEN_STATUSES = ['pending', 'confirming'] as const;

export class WalletPoolService {
  constructor(private readonly db: Database) {}

  /**
   * Register one of the merchant's own addresses, or revive it if it was retired.
   *
   * Upserted rather than inserted, because the unique index spans retired rows: a merchant who
   * retires a wallet and adds it back must end up with one row whose history is intact, not a
   * second row the allocator would treat as an independent wallet and hand the same address out
   * on twice.
   *
   * The address is stored in the chain's canonical form. On TRON that means Base58Check with
   * its case intact — this is the one place a merchant's typing enters the system, and storing
   * the 21-byte hex or a folded string here would make every later comparison a conversion.
   */
  async register(input: {
    readonly organizationId: string;
    readonly chain: ChainId;
    readonly address: string;
    readonly label?: string | undefined;
    readonly createdByUserId?: string | undefined;
    readonly pendingChangeId?: string | undefined;
  }): Promise<{ readonly id: string; readonly address: string }> {
    const address = addressKey(input.chain, input.address);

    const [row] = await this.db
      .insert(depositWallets)
      .values({
        organizationId: input.organizationId,
        chain: input.chain,
        address,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.createdByUserId === undefined
          ? {}
          : { createdByUserId: input.createdByUserId }),
        ...(input.pendingChangeId === undefined
          ? {}
          : { pendingChangeId: input.pendingChangeId }),
      })
      .onConflictDoUpdate({
        target: [depositWallets.organizationId, depositWallets.chain, depositWallets.address],
        set: {
          retiredAt: null,
          ...(input.label === undefined ? {} : { label: input.label }),
        },
      })
      .returning({ id: depositWallets.id, address: depositWallets.address });

    return row!;
  }

  /**
   * Take a wallet out of the pool.
   *
   * Retired, not deleted, and still matched against: invoices already pointing at it are open,
   * and a payment arriving there is still the merchant's money. Deleting the row would turn
   * every one of those payments into an unmatched one needing a human.
   */
  async retire(input: {
    readonly organizationId: string;
    readonly walletId: string;
  }): Promise<boolean> {
    const rows = await this.db
      .update(depositWallets)
      .set({ retiredAt: new Date() })
      .where(
        and(
          eq(depositWallets.id, input.walletId),
          eq(depositWallets.organizationId, input.organizationId),
          isNull(depositWallets.retiredAt),
        ),
      )
      .returning({ id: depositWallets.id });
    return rows.length > 0;
  }

  /** The pool as the merchant sees it, retired wallets included. */
  async list(input: {
    readonly organizationId: string;
    readonly chain?: ChainId | undefined;
  }): Promise<
    readonly {
      readonly id: string;
      readonly chain: string;
      readonly address: string;
      readonly label: string | null;
      readonly retiredAt: Date | null;
    }[]
  > {
    const where =
      input.chain === undefined
        ? eq(depositWallets.organizationId, input.organizationId)
        : and(
            eq(depositWallets.organizationId, input.organizationId),
            eq(depositWallets.chain, input.chain),
          );

    return this.db
      .select({
        id: depositWallets.id,
        chain: depositWallets.chain,
        address: depositWallets.address,
        label: depositWallets.label,
        retiredAt: depositWallets.retiredAt,
      })
      .from(depositWallets)
      .where(where)
      .orderBy(depositWallets.chain, depositWallets.address);
  }

  /**
   * Allocate a wallet and an exact amount for one new invoice.
   *
   * Must be called inside the transaction that inserts the invoice, and takes a
   * transaction-scoped lock on (organisation, chain) — so the allocation it returns is still
   * true when the insert lands. Called outside a transaction, the lock is released
   * immediately and the guarantee is gone; hence the transaction is a parameter rather than
   * something this method opens for itself.
   */
  async allocate(
    tx: Transaction,
    input: {
      readonly organizationId: string;
      readonly chain: ChainId;
      readonly base: bigint;
      readonly decimals: number;
      readonly random?: (() => number) | undefined;
    },
  ): Promise<PoolAllocation> {
    /**
     * Two 32-bit keys rather than one 64-bit hash of a string.
     *
     * `pg_advisory_xact_lock(int, int)` with the organisation in one half and the chain in the
     * other: distinct merchants and distinct chains cannot collide by hash, which a single
     * `hashtext` of a concatenation could. Held to the end of the transaction and released by
     * Postgres, so a failed insert cannot leave it held.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(${hash32(input.organizationId)}, ${hash32(input.chain)})`,
    );

    const pool = await tx
      .select({ id: depositWallets.id, address: depositWallets.address })
      .from(depositWallets)
      .where(
        and(
          eq(depositWallets.organizationId, input.organizationId),
          eq(depositWallets.chain, input.chain),
          isNull(depositWallets.retiredAt),
        ),
      );

    if (pool.length === 0) {
      throw new WalletPoolError(
        'pool_empty',
        `no deposit wallet is registered for ${input.chain}; add one before invoicing on it`,
      );
    }

    /**
     * Open invoices on these addresses, across the whole table rather than this organisation.
     *
     * Deliberate: these are the merchant's own wallets and nothing stops the same address
     * being registered by two accounts of one reseller. What must be unique is the amount
     * open *at an address*, because that is all a payment carries — the organisation it
     * belongs to is not written on the transfer.
     */
    const addresses = pool.map((row) => row.address);
    const open = await tx
      .select({ address: invoices.depositAddress, amountDue: invoices.amountDue })
      .from(invoices)
      .where(
        and(
          eq(invoices.chain, input.chain),
          sql`${invoices.depositAddress} in ${addresses}`,
          sql`${invoices.status} in ${OPEN_STATUSES}`,
        ),
      );

    const byAddress = new Map<string, bigint[]>(pool.map((row) => [row.address, []]));
    for (const row of open) {
      byAddress.get(row.address)?.push(BigInt(row.amountDue));
    }

    const loads: WalletLoad[] = pool.map((row) => ({
      id: row.id,
      address: row.address,
      openAmounts: byAddress.get(row.address) ?? [],
    }));

    const chosen = chooseWallet(loads);
    const amountDue = chooseAmount({
      base: input.base,
      decimals: input.decimals,
      taken: chosen.openAmounts,
      ...(input.random === undefined ? {} : { random: input.random }),
    });

    return { walletId: chosen.id, address: chosen.address, amountDue };
  }

  /**
   * Which of this chain's pooled addresses are live, for the watcher.
   *
   * Retired ones included: an invoice open against a retired wallet is still owed money, and a
   * watcher that stopped looking at the address would miss the payment entirely.
   */
  async watchedAddresses(chain: ChainId): Promise<readonly string[]> {
    const rows = await this.db
      .selectDistinct({ address: depositWallets.address })
      .from(depositWallets)
      .where(eq(depositWallets.chain, chain));
    return rows.map((row) => row.address);
  }
}

/**
 * A stable 32-bit signed integer for an advisory-lock key.
 *
 * FNV-1a, and written out rather than reached for from a library because the value must never
 * change: a different hash after a deploy means the old and new processes lock on different
 * keys and both allocate at once, which is the exact race this is for.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // `| 0` to land in the signed range Postgres's `integer` accepts.
  return hash | 0;
}
