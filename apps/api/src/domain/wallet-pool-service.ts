import { SUPPORTED_CHAINS, addressKey, chainConfig, isTronAddress } from '@avex/core';
import type { ChainId } from '@avex/core';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../db/client.js';
import { depositWallets, invoices, memberships, pendingChanges, users } from '../db/schema.js';
import type { Mailer } from '../mailer.js';
import type { AuditService } from './audit.js';
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

/**
 * The change kind for adding a wallet to a pool.
 *
 * Its own kind rather than reusing the payout one, because the applier has to know which table
 * to write and because a member cancelling a scheduled change should be told which of the two
 * they are cancelling.
 */
export const DEPOSIT_WALLET_CHANGE_KIND = 'deposit_wallet.add';

interface WalletChangePayload {
  readonly chain: string;
  readonly address: string;
  readonly label?: string | undefined;
}

export interface WalletChangeOutcome {
  /** `active` when the wallet is usable now; `pending` when it is scheduled. */
  readonly status: 'active' | 'pending';
  readonly address: string;
  readonly effectiveAt: Date | null;
  readonly pendingChangeId: string | null;
}

export class WalletPoolChangeError extends Error {
  constructor(
    readonly code: 'unsupported_chain' | 'not_pooled' | 'unchanged' | 'change_already_pending' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'WalletPoolChangeError';
  }
}

/**
 * Adding a wallet, on a delay, for the same reason a payout address changes on one.
 *
 * A pooled chain's deposit wallet *is* where the money lands — the payer's transfer goes into it
 * and nothing ever moves it — so somebody who adds their own address to a merchant's pool is
 * redirecting that merchant's income. Exactly the payout-address threat, so exactly the payout
 * address's protection: owner-only, elevation-gated at the route, twenty-four hours before it
 * takes effect, and an email to every member in between.
 *
 * The first wallet on a chain is immediate. There is nothing to redirect: a merchant with no
 * wallet cannot take payments on that chain at all, so a delay would only stop them starting.
 * That is the same rule the payout service applies to a first address, and for the same reason.
 *
 * Retiring is immediate too, and deliberately asymmetric. Taking a destination away can only
 * stop money arriving somewhere; a delay on it would mean a merchant who spotted a wrong address
 * had to wait a day to stop using it.
 */
export class WalletPoolChanges {
  constructor(
    private readonly db: Database,
    private readonly pool: WalletPoolService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly delayMs: number = 24 * 60 * 60 * 1000,
  ) {}

  async requestAdd(input: {
    readonly organizationId: string;
    readonly chain: ChainId;
    readonly address: string;
    readonly label?: string | undefined;
    readonly actor: { readonly userId: string; readonly ip?: string | null };
    readonly now?: Date;
  }): Promise<WalletChangeOutcome> {
    const now = input.now ?? new Date();

    if (!SUPPORTED_CHAINS.includes(input.chain)) {
      throw new WalletPoolChangeError('unsupported_chain', `${input.chain} is not supported.`);
    }
    if (chainConfig(input.chain).addressModel !== 'pooled') {
      /**
       * Refused rather than accepted and ignored.
       *
       * On every other chain the deposit address is derived and a registered wallet would do
       * nothing at all — so a merchant who added one would believe they had configured
       * something. They want `payout-addresses` for those chains, and the message says so.
       */
      throw new WalletPoolChangeError(
        'not_pooled',
        `${input.chain} does not use a wallet pool: its deposit addresses are derived. Set a ` +
          'payout address for it instead.',
      );
    }

    /**
     * Normalised before anything compares it.
     *
     * A TRON address arrives from a merchant's clipboard in any of three forms, and a pool
     * holding the same wallet twice would let the allocator treat one address as two — handing
     * it to two invoices as though they were on separate wallets, which is the state the
     * amount-matching cannot untangle.
     */
    const address = addressKey(input.chain, input.address);
    if (!isTronAddress(input.address) && input.chain === 'tron') {
      throw new WalletPoolChangeError('unsupported_chain', 'That is not a valid TRON address.');
    }

    const live = await this.pool.list({
      organizationId: input.organizationId,
      chain: input.chain,
    });
    if (live.some((row) => row.address === address && row.retiredAt === null)) {
      throw new WalletPoolChangeError('unchanged', 'That wallet is already in your pool.');
    }

    const outstanding = await this.pendingFor(input.organizationId, input.chain, address);
    if (outstanding) {
      throw new WalletPoolChangeError(
        'change_already_pending',
        'That wallet is already scheduled to be added. Cancel it before requesting it again.',
      );
    }

    const first = live.every((row) => row.retiredAt !== null);
    if (first) {
      const created = await this.pool.register({
        organizationId: input.organizationId,
        chain: input.chain,
        address,
        ...(input.label === undefined ? {} : { label: input.label }),
        createdByUserId: input.actor.userId,
      });
      await this.audit.record({
        organizationId: input.organizationId,
        userId: input.actor.userId,
        ip: input.actor.ip ?? null,
        action: 'deposit_wallet.added',
        targetType: 'deposit_wallet',
        targetId: created.id,
        metadata: { chain: input.chain, address, firstForChain: true },
      });
      return { status: 'active', address, effectiveAt: null, pendingChangeId: null };
    }

    const effectiveAt = new Date(now.getTime() + this.delayMs);
    const payload: WalletChangePayload = {
      chain: input.chain,
      address,
      ...(input.label === undefined ? {} : { label: input.label }),
    };
    const [change] = await this.db
      .insert(pendingChanges)
      .values({
        organizationId: input.organizationId,
        kind: DEPOSIT_WALLET_CHANGE_KIND,
        payload: payload as unknown as Record<string, unknown>,
        requestedByUserId: input.actor.userId,
        requestedAt: now,
        effectiveAt,
      })
      .returning({ id: pendingChanges.id });

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId,
      ip: input.actor.ip ?? null,
      action: 'deposit_wallet.add_requested',
      targetType: 'pending_change',
      targetId: change!.id,
      metadata: { chain: input.chain, address, effectiveAt: effectiveAt.toISOString() },
    });

    // Everyone, not just the requester. A delay nobody is told about protects nothing, and the
    // person who needs to see it is precisely the one who did not make the request.
    await this.notifyMembers(input.organizationId, input.chain, address, effectiveAt);

    return { status: 'pending', address, effectiveAt, pendingChangeId: change!.id };
  }

  /** Scheduled additions not yet applied or cancelled. */
  async pending(organizationId: string): Promise<
    readonly {
      readonly id: string;
      readonly chain: string;
      readonly address: string;
      readonly effectiveAt: Date;
    }[]
  > {
    const rows = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.organizationId, organizationId),
          eq(pendingChanges.kind, DEPOSIT_WALLET_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
        ),
      );

    return rows.map((row) => {
      const payload = row.payload as unknown as WalletChangePayload;
      return {
        id: row.id,
        chain: payload.chain,
        address: payload.address,
        effectiveAt: row.effectiveAt,
      };
    });
  }

  /**
   * Cancel a scheduled addition.
   *
   * Any member may do this, which is the point of the delay: it protects nothing if only the
   * account that requested it can stop it, and a compromised owner must not be the sole party
   * able to intervene. The route enforces the read permission, not the write one.
   */
  async cancel(input: {
    readonly organizationId: string;
    readonly changeId: string;
    readonly actor: { readonly userId: string; readonly ip?: string | null };
  }): Promise<void> {
    const rows = await this.db
      .update(pendingChanges)
      .set({ cancelledAt: new Date(), cancelledByUserId: input.actor.userId })
      .where(
        and(
          eq(pendingChanges.id, input.changeId),
          eq(pendingChanges.organizationId, input.organizationId),
          eq(pendingChanges.kind, DEPOSIT_WALLET_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
        ),
      )
      .returning({ id: pendingChanges.id });

    if (rows.length === 0) {
      throw new WalletPoolChangeError(
        'not_found',
        'No such scheduled change. It may already have been applied or cancelled.',
      );
    }

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId,
      ip: input.actor.ip ?? null,
      action: 'deposit_wallet.add_cancelled',
      targetType: 'pending_change',
      targetId: input.changeId,
    });
  }

  /** Apply everything whose delay has elapsed. Driven by the payout job's clock. */
  async applyDueChanges(now: Date = new Date()): Promise<number> {
    const due = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.kind, DEPOSIT_WALLET_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
          lte(pendingChanges.effectiveAt, now),
        ),
      );

    let applied = 0;
    for (const change of due) {
      const payload = change.payload as unknown as WalletChangePayload;

      await this.db.transaction(async (tx) => {
        /**
         * Written here rather than through `register`, so the whole application is one
         * transaction with the change being marked applied. A registration that landed while
         * the mark failed would be re-applied on the next tick — harmless for an upsert, and
         * still the kind of thing that makes a run count meaningless.
         */
        await tx
          .insert(depositWallets)
          .values({
            organizationId: change.organizationId,
            chain: payload.chain,
            address: payload.address,
            ...(payload.label === undefined ? {} : { label: payload.label }),
            ...(change.requestedByUserId === null
              ? {}
              : { createdByUserId: change.requestedByUserId }),
            pendingChangeId: change.id,
          })
          .onConflictDoUpdate({
            target: [depositWallets.organizationId, depositWallets.chain, depositWallets.address],
            set: { retiredAt: null, pendingChangeId: change.id },
          });

        await tx
          .update(pendingChanges)
          .set({ appliedAt: now })
          .where(eq(pendingChanges.id, change.id));
      });

      await this.audit.record({
        organizationId: change.organizationId,
        userId: change.requestedByUserId,
        action: 'deposit_wallet.add_applied',
        targetType: 'pending_change',
        targetId: change.id,
        metadata: { chain: payload.chain, address: payload.address },
      });
      applied += 1;
    }
    return applied;
  }

  private async pendingFor(organizationId: string, chain: string, address: string) {
    const rows = await this.pending(organizationId);
    return rows.find((row) => row.chain === chain && row.address === address);
  }

  private async notifyMembers(
    organizationId: string,
    chain: string,
    address: string,
    effectiveAt: Date,
  ): Promise<void> {
    const recipients = await this.db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId));

    for (const recipient of recipients) {
      /**
       * The payout-change notice, reused, because the claim is the same one.
       *
       * On a pooled chain the deposit wallet *is* the payout address — the payer's transfer
       * lands in it and nothing ever moves the funds — so "a change to your payout address is
       * scheduled" is accurate rather than approximate. A second template saying the same thing
       * in different words would be one more place for the two to drift.
       */
      await this.mailer
        .sendPayoutChangeQueued(recipient.email, { chain, newAddress: address, effectiveAt })
        .catch(() => undefined);
    }
  }
}
