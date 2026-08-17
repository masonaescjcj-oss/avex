import { SUPPORTED_CHAINS, toChecksumAddress, type ChainId } from '@avex/core';
import { and, eq, isNull, lte } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { memberships, payoutAddresses, pendingChanges, users } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { Mailer } from '../mailer.js';

/**
 * Payout addresses — where a merchant's settled funds are sent.
 *
 * This is the most valuable thing in the system to an attacker. Breaking the
 * contracts is hard; changing one row here redirects every future payment, and
 * does it quietly. So a replacement does not take effect when it is requested:
 * it is queued, every member is told, and anyone can cancel it during the delay.
 *
 * The delay is the actual protection. Two-factor and role limits raise the cost of
 * getting in; only the delay gives the merchant a chance to notice and undo it.
 */

export const PAYOUT_CHANGE_KIND = 'payout_address.change';

/** How long a replacement waits before taking effect. */
export const PAYOUT_CHANGE_DELAY_MS = 24 * 60 * 60 * 1000;

export class PayoutAddressError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutAddressError';
  }
}

export interface PayoutChangePayload {
  readonly chain: ChainId;
  readonly address: string;
  readonly replacesAddressId: string | null;
}

export interface RequestOutcome {
  /** `active` when applied at once, `pending` when it must wait out the delay. */
  readonly status: 'active' | 'pending';
  readonly address: string;
  readonly effectiveAt: Date | null;
  readonly pendingChangeId: string | null;
}

export class PayoutAddressService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly delayMs: number = PAYOUT_CHANGE_DELAY_MS,
  ) {}

  /**
   * Validate an address for its chain.
   *
   * Rejecting a malformed address here matters more than it looks: a settlement
   * sent to an unparseable or mistyped address is unrecoverable, and the merchant
   * finds out only once funds have already moved.
   */
  static normalizeAddress(chain: ChainId, address: string): string {
    const trimmed = address.trim();

    if (chain === 'ethereum' || chain === 'polygon' || chain === 'bsc') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
        throw new PayoutAddressError(
          'invalid_address',
          'An EVM address must be 0x followed by 40 hexadecimal characters.',
        );
      }
      if (/^0x0{40}$/.test(trimmed)) {
        throw new PayoutAddressError(
          'invalid_address',
          'The zero address would burn every payment sent to it.',
        );
      }
      // Stored checksummed so a comparison never depends on how it was typed.
      return toChecksumAddress(trimmed);
    }

    if (chain === 'ton') {
      // TON user-friendly addresses are 48 base64url characters.
      if (!/^[A-Za-z0-9_-]{48}$/.test(trimmed)) {
        throw new PayoutAddressError(
          'invalid_address',
          'A TON address must be 48 characters in base64url form.',
        );
      }
      return trimmed;
    }

    if (chain === 'tron') {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) {
        throw new PayoutAddressError(
          'invalid_address',
          'A TRON address must start with T and be 34 characters of base58.',
        );
      }
      return trimmed;
    }

    if (chain === 'solana') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
        throw new PayoutAddressError(
          'invalid_address',
          'A Solana address must be 32 to 44 characters of base58.',
        );
      }
      return trimmed;
    }

    throw new PayoutAddressError('unsupported_chain', `${chain} is not supported.`);
  }

  async activeAddress(organizationId: string, chain: ChainId): Promise<string | null> {
    const [row] = await this.db
      .select({ address: payoutAddresses.address })
      .from(payoutAddresses)
      .where(
        and(
          eq(payoutAddresses.organizationId, organizationId),
          eq(payoutAddresses.chain, chain),
          isNull(payoutAddresses.supersededAt),
        ),
      )
      .limit(1);
    return row?.address ?? null;
  }

  async list(organizationId: string) {
    const active = await this.db
      .select()
      .from(payoutAddresses)
      .where(
        and(
          eq(payoutAddresses.organizationId, organizationId),
          isNull(payoutAddresses.supersededAt),
        ),
      );

    const pending = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.organizationId, organizationId),
          eq(pendingChanges.kind, PAYOUT_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
        ),
      );

    return {
      active: active.map((row) => ({
        id: row.id,
        chain: row.chain,
        address: row.address,
        activeFrom: row.activeFrom.toISOString(),
      })),
      pending: pending.map((row) => {
        const payload = row.payload as unknown as PayoutChangePayload;
        return {
          id: row.id,
          chain: payload.chain,
          address: payload.address,
          requestedAt: row.requestedAt.toISOString(),
          effectiveAt: row.effectiveAt.toISOString(),
        };
      }),
    };
  }

  /**
   * Set or replace the payout address for a chain.
   *
   * The first address for a chain takes effect at once. There is nothing to
   * redirect yet, so a delay would only obstruct setup without protecting
   * anything — the delay exists to guard funds already flowing somewhere.
   */
  async requestChange(
    organizationId: string,
    chain: ChainId,
    rawAddress: string,
    actor: { userId: string; ip?: string | null },
    now: Date = new Date(),
  ): Promise<RequestOutcome> {
    if (!SUPPORTED_CHAINS.includes(chain)) {
      throw new PayoutAddressError('unsupported_chain', `${chain} is not supported.`);
    }
    const address = PayoutAddressService.normalizeAddress(chain, rawAddress);

    const current = await this.db
      .select()
      .from(payoutAddresses)
      .where(
        and(
          eq(payoutAddresses.organizationId, organizationId),
          eq(payoutAddresses.chain, chain),
          isNull(payoutAddresses.supersededAt),
        ),
      )
      .limit(1);
    const existing = current[0];

    if (existing?.address === address) {
      throw new PayoutAddressError(
        'unchanged',
        'That is already your payout address for this chain.',
      );
    }

    // One outstanding change per chain. Allowing several would make the
    // notification emails ambiguous about which one a member is cancelling.
    const outstanding = await this.pendingForChain(organizationId, chain);
    if (outstanding) {
      throw new PayoutAddressError(
        'change_already_pending',
        'A change for this chain is already scheduled. Cancel it before requesting another.',
      );
    }

    if (!existing) {
      const [created] = await this.db
        .insert(payoutAddresses)
        .values({
          organizationId,
          chain,
          address,
          createdByUserId: actor.userId,
          activeFrom: now,
        })
        .returning({ id: payoutAddresses.id });

      await this.audit.record({
        organizationId,
        userId: actor.userId,
        ip: actor.ip ?? null,
        action: 'payout_address.set',
        targetType: 'payout_address',
        targetId: created!.id,
        metadata: { chain, address, firstForChain: true },
      });

      return { status: 'active', address, effectiveAt: null, pendingChangeId: null };
    }

    const effectiveAt = new Date(now.getTime() + this.delayMs);
    const payload: PayoutChangePayload = {
      chain,
      address,
      replacesAddressId: existing.id,
    };

    const [change] = await this.db
      .insert(pendingChanges)
      .values({
        organizationId,
        kind: PAYOUT_CHANGE_KIND,
        payload: payload as unknown as Record<string, unknown>,
        requestedByUserId: actor.userId,
        requestedAt: now,
        effectiveAt,
      })
      .returning({ id: pendingChanges.id });

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      ip: actor.ip ?? null,
      action: 'payout_address.change_requested',
      targetType: 'pending_change',
      targetId: change!.id,
      metadata: {
        chain,
        from: existing.address,
        to: address,
        effectiveAt: effectiveAt.toISOString(),
      },
    });

    // Everyone, not just the requester. A delay nobody is told about protects
    // nothing, and the person who needs to see this is precisely the one who did
    // not make the request.
    await this.notifyMembers(organizationId, chain, address, effectiveAt);

    return {
      status: 'pending',
      address,
      effectiveAt,
      pendingChangeId: change!.id,
    };
  }

  private async pendingForChain(organizationId: string, chain: ChainId) {
    const rows = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.organizationId, organizationId),
          eq(pendingChanges.kind, PAYOUT_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
        ),
      );
    return rows.find((row) => (row.payload as unknown as PayoutChangePayload).chain === chain);
  }

  /**
   * Cancel a scheduled change.
   *
   * Deliberately available to any member, including a viewer. The delay is only
   * worth having if whoever notices the email can act on it — requiring the owner
   * to cancel would leave a compromised owner account unstoppable, which is the
   * exact scenario being defended against.
   */
  async cancelChange(
    organizationId: string,
    changeId: string,
    actor: { userId: string; ip?: string | null },
    now: Date = new Date(),
  ): Promise<void> {
    const [change] = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(eq(pendingChanges.id, changeId), eq(pendingChanges.organizationId, organizationId)),
      )
      .limit(1);

    if (!change || change.kind !== PAYOUT_CHANGE_KIND) {
      throw new PayoutAddressError('not_found', 'No such scheduled change.');
    }
    if (change.cancelledAt !== null) {
      throw new PayoutAddressError('already_cancelled', 'That change was already cancelled.');
    }
    if (change.appliedAt !== null) {
      throw new PayoutAddressError(
        'already_applied',
        'That change has already taken effect. Request a new one to change it back.',
      );
    }

    await this.db
      .update(pendingChanges)
      .set({ cancelledAt: now, cancelledByUserId: actor.userId })
      .where(eq(pendingChanges.id, changeId));

    const payload = change.payload as unknown as PayoutChangePayload;
    await this.audit.record({
      organizationId,
      userId: actor.userId,
      ip: actor.ip ?? null,
      action: 'payout_address.change_cancelled',
      targetType: 'pending_change',
      targetId: changeId,
      metadata: { chain: payload.chain, wouldHaveBecome: payload.address },
    });
  }

  /**
   * Apply every change whose delay has elapsed. Run on a timer.
   *
   * Each change is applied in a transaction that supersedes the old address and
   * inserts the new one together, so the partial unique index can never see two
   * active addresses for a chain.
   */
  async applyDueChanges(now: Date = new Date()): Promise<number> {
    const due = await this.db
      .select()
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.kind, PAYOUT_CHANGE_KIND),
          isNull(pendingChanges.appliedAt),
          isNull(pendingChanges.cancelledAt),
          lte(pendingChanges.effectiveAt, now),
        ),
      );

    let applied = 0;

    for (const change of due) {
      const payload = change.payload as unknown as PayoutChangePayload;

      await this.db.transaction(async (tx) => {
        if (payload.replacesAddressId) {
          await tx
            .update(payoutAddresses)
            .set({ supersededAt: now })
            .where(
              and(
                eq(payoutAddresses.id, payload.replacesAddressId),
                isNull(payoutAddresses.supersededAt),
              ),
            );
        }

        await tx.insert(payoutAddresses).values({
          organizationId: change.organizationId,
          chain: payload.chain,
          address: payload.address,
          activeFrom: now,
          createdByUserId: change.requestedByUserId,
          pendingChangeId: change.id,
        });

        await tx
          .update(pendingChanges)
          .set({ appliedAt: now })
          .where(eq(pendingChanges.id, change.id));
      });

      await this.audit.record({
        organizationId: change.organizationId,
        userId: change.requestedByUserId,
        action: 'payout_address.change_applied',
        targetType: 'pending_change',
        targetId: change.id,
        metadata: { chain: payload.chain, address: payload.address },
      });

      applied += 1;
    }

    return applied;
  }

  private async notifyMembers(
    organizationId: string,
    chain: ChainId,
    newAddress: string,
    effectiveAt: Date,
  ): Promise<void> {
    const recipients = await this.db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, organizationId), isNull(memberships.revokedAt)),
      );

    for (const recipient of recipients) {
      // One failed email must not abandon the rest, or a delivery problem would
      // silently reduce how many people could have caught this.
      await this.mailer
        .sendPayoutChangeQueued(recipient.email, { chain, newAddress, effectiveAt })
        .catch(() => undefined);
    }
  }
}
