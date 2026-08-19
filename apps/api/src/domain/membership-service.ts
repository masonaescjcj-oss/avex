import { and, eq, isNull, ne } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { memberships, users } from '../db/schema.js';
import type { AuditService } from './audit.js';
import type { Mailer } from '../mailer.js';
import { assignableRoles } from './rbac.js';
import type { Role } from './rbac.js';

/**
 * Removing somebody, and changing what they can do.
 *
 * One invariant runs through the whole file: an organisation always has at least one
 * owner. Owner is the only role that can change where money is sent, so an organisation
 * with none is one whose payout address can never be changed again — by anybody, ever,
 * including us. There is no repair for it that does not involve an operator reaching into
 * the database, which is exactly the class of thing this codebase exists to avoid.
 *
 * So the last owner cannot be removed and cannot be demoted, and both refusals say which
 * of the two happened rather than reporting a generic failure. "You cannot do that" sends
 * somebody looking for a permission problem; "promote somebody else first" is the actual
 * next step.
 *
 * Neither operation touches sessions. Role is read from this table on every request, so a
 * demotion applies to the next one the victim makes and a removal applies to the one after
 * it too — nothing has to be invalidated, and nothing can be missed.
 */

export type RemoveOutcome =
  | { readonly status: 'removed'; readonly email: string; readonly role: Role }
  | { readonly status: 'not_a_member' }
  /** They are the only owner. Somebody else has to be promoted first. */
  | { readonly status: 'last_owner' };

export type RoleChangeOutcome =
  | {
      readonly status: 'changed';
      readonly email: string;
      readonly from: Role;
      readonly to: Role;
    }
  /** Already that role. Reported rather than written, so the audit log stays meaningful. */
  | { readonly status: 'unchanged'; readonly role: Role }
  | { readonly status: 'not_a_member' }
  | { readonly status: 'last_owner' }
  | { readonly status: 'role_not_assignable'; readonly role: Role };

export interface MembershipActor {
  readonly userId?: string | null;
  readonly apiKeyId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export class MembershipService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Whether the organisation would still have an owner if this membership stopped being
   * one — by removal or by demotion.
   *
   * Asked as "is there another live owner", not "how many owners are there", because the
   * count is only ever compared against one and the query stops at the first row.
   */
  private async anotherOwnerExists(
    organizationId: string,
    besidesUserId: string,
  ): Promise<boolean> {
    const [other] = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, 'owner'),
          ne(memberships.userId, besidesUserId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    return other !== undefined;
  }

  private async member(
    organizationId: string,
    userId: string,
  ): Promise<{ role: Role; email: string } | null> {
    const [row] = await this.db
      .select({ role: memberships.role, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Revoke a membership.
   *
   * Revoked with a timestamp, never deleted. "When did this person lose access" is a
   * question asked during incidents, and a deleted row cannot answer it — which is also
   * why re-inviting somebody reinstates this row rather than making a second one.
   *
   * What this does *not* do is revoke API keys the person created. Those belong to the
   * organisation, not to them, and killing them on departure would take production down as
   * a side effect of an HR action. The caller is told so it can say it out loud, because
   * the alternative is an operator assuming access is gone when a key is still live.
   */
  async remove(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly actor: MembershipActor;
    readonly now?: Date;
  }): Promise<RemoveOutcome> {
    const existing = await this.member(input.organizationId, input.userId);
    if (!existing) return { status: 'not_a_member' };

    if (
      existing.role === 'owner' &&
      !(await this.anotherOwnerExists(input.organizationId, input.userId))
    ) {
      return { status: 'last_owner' };
    }

    const now = input.now ?? new Date();
    await this.db
      .update(memberships)
      .set({ revokedAt: now })
      .where(
        and(
          eq(memberships.organizationId, input.organizationId),
          eq(memberships.userId, input.userId),
          isNull(memberships.revokedAt),
        ),
      );

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId ?? null,
      apiKeyId: input.actor.apiKeyId ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      action: 'member.removed',
      targetType: 'membership',
      targetId: input.userId,
      metadata: {
        email: existing.email,
        role: existing.role,
        /** A departure is a different act from being shown the door. */
        self: input.actor.userId === input.userId,
      },
    });

    /**
     * Told, unless they did it themselves.
     *
     * Somebody who leaves does not need an email about leaving. Somebody who was removed
     * finds out from a 404 otherwise, which is how a person concludes the product is broken
     * rather than that a decision was made.
     */
    if (input.actor.userId !== input.userId) {
      await this.mailer
        .sendMembershipRevoked(existing.email, { organizationId: input.organizationId })
        .catch(() => undefined);
    }

    return { status: 'removed', email: existing.email, role: existing.role };
  }

  /**
   * Move somebody between roles.
   *
   * A separate operation from inviting, deliberately: an invitation cannot raise an
   * existing member, so this is the only path, and it is elevated and audited because it
   * is the one that can hand somebody the payout address.
   */
  async changeRole(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: Role;
    readonly actorRole: Role | null;
    readonly actor: MembershipActor;
    readonly now?: Date;
  }): Promise<RoleChangeOutcome> {
    /**
     * The ceiling is checked here as well as in the route, for the same reason the invite
     * service checks it: this is the object that can grant a role, so this is the object
     * that has to refuse. A second caller added later inherits the rule by construction
     * rather than by remembering.
     */
    if (input.actorRole !== null && !assignableRoles(input.actorRole).includes(input.role)) {
      return { status: 'role_not_assignable', role: input.role };
    }

    const existing = await this.member(input.organizationId, input.userId);
    if (!existing) return { status: 'not_a_member' };
    if (existing.role === input.role) return { status: 'unchanged', role: existing.role };

    if (
      existing.role === 'owner' &&
      !(await this.anotherOwnerExists(input.organizationId, input.userId))
    ) {
      // Includes an owner demoting themselves, which is the likeliest way to reach this:
      // handing over and stepping back, in the wrong order.
      return { status: 'last_owner' };
    }

    const now = input.now ?? new Date();
    await this.db
      .update(memberships)
      .set({ role: input.role })
      .where(
        and(
          eq(memberships.organizationId, input.organizationId),
          eq(memberships.userId, input.userId),
          isNull(memberships.revokedAt),
        ),
      );

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId ?? null,
      apiKeyId: input.actor.apiKeyId ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      action: 'member.role_changed',
      targetType: 'membership',
      targetId: input.userId,
      // Both ends, because "was made an admin" and "was demoted to admin" are different
      // events and only the pair distinguishes them.
      metadata: { email: existing.email, from: existing.role, to: input.role, at: now.toISOString() },
    });

    if (input.actor.userId !== input.userId) {
      await this.mailer
        .sendRoleChanged(existing.email, {
          organizationId: input.organizationId,
          from: existing.role,
          to: input.role,
        })
        .catch(() => undefined);
    }

    return { status: 'changed', email: existing.email, from: existing.role, to: input.role };
  }
}
