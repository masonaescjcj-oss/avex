import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { apiKeys, memberships, organizationInvites, users } from '../db/schema.js';
import { hashToken, issueToken } from '../auth/tokens.js';
import type { AuditService } from './audit.js';
import { assignableRoles, can } from './rbac.js';
import type { Role } from './rbac.js';

/**
 * Invitations to join an organisation.
 *
 * The whole difficulty here is that an invitation is a capability that outlives the
 * moment it was authorised. Everything else in this system is checked at the instant
 * it happens; an invitation sits in somebody's inbox for a week, and the world moves
 * while it waits. Two consequences shape this file:
 *
 *   - Acceptance re-checks the inviter. An owner who invites another owner and is
 *     then demoted to viewer would otherwise still be handing out the role they can
 *     no longer grant, days after losing the right to.
 *   - Acceptance requires a session whose address is the invited one. The token
 *     proves somebody read that mailbox, and forwarding a mail is an ordinary thing
 *     to do — so the token alone must not be enough.
 *
 * Nothing here changes an existing member's role. Accepting an invitation means
 * joining; a role change is a separate, elevated, audited action. Letting an
 * invitation do it would make "invite" a quiet path around `member:role_change`.
 */

/** How long an invitation stands. Long enough for a holiday, short enough to expire. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly invitedAt: Date;
  readonly expiresAt: Date;
  readonly invitedByEmail: string | null;
}

export interface CreatedInvite {
  readonly id: string;
  /** The only time the token exists in the clear. It leaves by email or not at all. */
  readonly token: string;
  readonly expiresAt: Date;
  /** Invitations for the same address that this one replaced. */
  readonly supersededCount: number;
}

/**
 * Why an acceptance did or did not happen.
 *
 * A union rather than a boolean because the caller has something different to say in
 * each case, and "invalid" covering all of them would leave a person who signed in
 * with the wrong account reading that their invitation is broken.
 */
export type AcceptOutcome =
  | { readonly status: 'accepted'; readonly organizationId: string; readonly role: Role }
  | {
      readonly status: 'already_member';
      readonly organizationId: string;
      /** The role they already had, which this does not touch. */
      readonly role: Role;
    }
  /** Held by somebody signed in as a different address. */
  | { readonly status: 'wrong_account'; readonly invitedEmail: string }
  | { readonly status: 'expired' }
  /** The inviter can no longer grant this role, or at all. */
  | { readonly status: 'inviter_unauthorized' }
  /** Unknown, already spent, or revoked. */
  | { readonly status: 'invalid' };

export interface InviteActor {
  readonly userId?: string | null;
  readonly apiKeyId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export class RoleNotAssignableError extends Error {
  constructor(readonly role: Role) {
    super(`role ${role} is above the inviter's own`);
    this.name = 'RoleNotAssignableError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InviteService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: { readonly ttlMs?: number } = {},
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? INVITE_TTL_MS;
  }

  /**
   * Create an invitation, replacing any that are still outstanding for the same
   * address.
   *
   * Replacing rather than adding, because two live invitations for one person with
   * different roles has no correct answer — whichever link they happen to click
   * decides what they get. The latest invitation is the invitation.
   */
  async invite(input: {
    readonly organizationId: string;
    readonly email: string;
    readonly role: Role;
    readonly actorRole: Role | null;
    readonly actor: InviteActor;
    readonly now?: Date;
  }): Promise<CreatedInvite> {
    /**
     * The ceiling is checked here as well as in the route.
     *
     * Not redundancy for its own sake: this is the object that can grant a role, so
     * it is the object that has to refuse. A second caller added later would
     * otherwise inherit the route's check by accident rather than by construction.
     */
    if (input.actorRole !== null && !assignableRoles(input.actorRole).includes(input.role)) {
      throw new RoleNotAssignableError(input.role);
    }

    const email = normalizeEmail(input.email);
    const now = input.now ?? new Date();

    const superseded = await this.db
      .update(organizationInvites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(organizationInvites.organizationId, input.organizationId),
          eq(organizationInvites.email, email),
          isNull(organizationInvites.acceptedAt),
          isNull(organizationInvites.revokedAt),
        ),
      )
      .returning({ id: organizationInvites.id });

    const token = issueToken();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    const [created] = await this.db
      .insert(organizationInvites)
      .values({
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: token.hash,
        invitedByUserId: input.actor.userId ?? null,
        invitedByApiKeyId: input.actor.apiKeyId ?? null,
        createdAt: now,
        expiresAt,
      })
      .returning({ id: organizationInvites.id });

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId ?? null,
      apiKeyId: input.actor.apiKeyId ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      action: 'member.invited',
      targetType: 'email',
      targetId: email,
      metadata: { role: input.role, inviteId: created!.id, superseded: superseded.length },
    });

    return {
      id: created!.id,
      token: token.token,
      expiresAt,
      supersededCount: superseded.length,
    };
  }

  /**
   * Invitations still waiting, newest first.
   *
   * Expired ones are included and dated rather than filtered out. "I invited them
   * and nothing happened" is the question this list answers, and an invitation that
   * silently disappeared on its expiry answers it wrongly.
   */
  async pending(organizationId: string): Promise<readonly PendingInvite[]> {
    const rows = await this.db
      .select({
        id: organizationInvites.id,
        email: organizationInvites.email,
        role: organizationInvites.role,
        invitedAt: organizationInvites.createdAt,
        expiresAt: organizationInvites.expiresAt,
        invitedByEmail: users.email,
      })
      .from(organizationInvites)
      .leftJoin(users, eq(users.id, organizationInvites.invitedByUserId))
      .where(
        and(
          eq(organizationInvites.organizationId, organizationId),
          isNull(organizationInvites.acceptedAt),
          isNull(organizationInvites.revokedAt),
        ),
      )
      .orderBy(desc(organizationInvites.createdAt));

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      invitedAt: row.invitedAt,
      expiresAt: row.expiresAt,
      invitedByEmail: row.invitedByEmail,
    }));
  }

  /**
   * Withdraw an outstanding invitation.
   *
   * The only defence once the mail has left, so it is scoped by organisation in the
   * same statement rather than checked first: an id from one organisation must not
   * be spendable against another.
   */
  async revoke(input: {
    readonly organizationId: string;
    readonly inviteId: string;
    readonly actor: InviteActor;
    readonly now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const [revoked] = await this.db
      .update(organizationInvites)
      .set({ revokedAt: now })
      .where(
        and(
          eq(organizationInvites.id, input.inviteId),
          eq(organizationInvites.organizationId, input.organizationId),
          isNull(organizationInvites.acceptedAt),
          isNull(organizationInvites.revokedAt),
        ),
      )
      .returning({ id: organizationInvites.id, email: organizationInvites.email });

    if (!revoked) return false;

    await this.audit.record({
      organizationId: input.organizationId,
      userId: input.actor.userId ?? null,
      apiKeyId: input.actor.apiKeyId ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      action: 'member.invite_revoked',
      targetType: 'email',
      targetId: revoked.email,
      metadata: { inviteId: revoked.id },
    });
    return true;
  }

  /** Whether the invitation's author may still grant what they offered. */
  private async inviterStillAuthorized(invite: {
    readonly organizationId: string;
    readonly role: Role;
    readonly invitedByUserId: string | null;
    readonly invitedByApiKeyId: string | null;
  }): Promise<boolean> {
    if (invite.invitedByUserId !== null) {
      const [membership] = await this.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, invite.organizationId),
            eq(memberships.userId, invite.invitedByUserId),
            isNull(memberships.revokedAt),
          ),
        )
        .limit(1);
      if (!membership) return false;
      return (
        can(membership.role, 'member:invite') &&
        assignableRoles(membership.role).includes(invite.role)
      );
    }

    if (invite.invitedByApiKeyId !== null) {
      /**
       * A key's scopes were checked when the invitation was made, so what is left to
       * ask is whether the key still exists. Revoking a leaked key has to kill what
       * it did, not only what it could do next.
       */
      const [key] = await this.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, invite.invitedByApiKeyId), isNull(apiKeys.revokedAt)))
        .limit(1);
      return key !== undefined;
    }

    // Neither: nothing to re-check, so nothing vouches for it.
    return false;
  }

  /**
   * Spend an invitation on behalf of a signed-in user.
   *
   * The user is the authority for *who* is joining and the token is the authority for
   * *what* they are joining as. Both are required, and they have to agree about the
   * address — see the note at the top of this file.
   */
  async accept(input: {
    readonly token: string;
    readonly userId: string;
    readonly actor?: Omit<InviteActor, 'userId'>;
    readonly now?: Date;
  }): Promise<AcceptOutcome> {
    const now = input.now ?? new Date();

    const [invite] = await this.db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.tokenHash, hashToken(input.token)))
      .limit(1);

    if (!invite) return { status: 'invalid' };
    if (invite.acceptedAt !== null || invite.revokedAt !== null) return { status: 'invalid' };
    if (invite.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };

    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) return { status: 'invalid' };

    if (normalizeEmail(user.email) !== invite.email) {
      /**
       * Reported as its own outcome, and it names the invited address.
       *
       * Safe to name: whoever is holding this token was sent it, or was forwarded a
       * mail that already contains it. Withholding it here would only leave somebody
       * signed in as the wrong colleague with no idea which account to use.
       */
      return { status: 'wrong_account', invitedEmail: invite.email };
    }

    if (!(await this.inviterStillAuthorized(invite))) {
      return { status: 'inviter_unauthorized' };
    }

    const [existing] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, invite.organizationId),
          eq(memberships.userId, user.id),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);

    /**
     * Spend the invitation either way, but leave an existing role alone.
     *
     * Consuming it matters: an unspent invitation for somebody who is already inside
     * is a live token that grants a role, sitting in a mailbox for another week.
     */
    await this.db
      .update(organizationInvites)
      .set({ acceptedAt: now, acceptedByUserId: user.id })
      .where(eq(organizationInvites.id, invite.id));

    if (existing) {
      await this.audit.record({
        organizationId: invite.organizationId,
        userId: user.id,
        ip: input.actor?.ip ?? null,
        userAgent: input.actor?.userAgent ?? null,
        action: 'member.invite_accepted_already_member',
        targetType: 'membership',
        targetId: user.id,
        metadata: { inviteId: invite.id, offeredRole: invite.role, keptRole: existing.role },
      });
      return {
        status: 'already_member',
        organizationId: invite.organizationId,
        role: existing.role,
      };
    }

    /**
     * A revoked membership is reinstated rather than duplicated: the unique index on
     * (organisation, user) means a second row is impossible, so somebody who was
     * removed and later re-invited would otherwise be unable to rejoin at all.
     */
    await this.db
      .insert(memberships)
      .values({ organizationId: invite.organizationId, userId: user.id, role: invite.role })
      .onConflictDoUpdate({
        target: [memberships.organizationId, memberships.userId],
        set: { role: invite.role, revokedAt: null, createdAt: now },
      });

    await this.audit.record({
      organizationId: invite.organizationId,
      userId: user.id,
      ip: input.actor?.ip ?? null,
      userAgent: input.actor?.userAgent ?? null,
      action: 'member.joined',
      targetType: 'membership',
      targetId: user.id,
      metadata: { inviteId: invite.id, role: invite.role },
    });

    return { status: 'accepted', organizationId: invite.organizationId, role: invite.role };
  }
}
