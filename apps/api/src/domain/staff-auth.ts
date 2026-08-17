import { and, eq, isNull, sql } from 'drizzle-orm';

import { hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import { hashToken, issueToken } from '../auth/tokens.js';
import { generateTotpSecret, totpUri, verifyTotp } from '../auth/totp.js';
import type { Database } from '../db/client.js';
import { staff, staffSessions } from '../db/schema.js';
import type { AuditService } from './audit.js';
import { STAFF_ROLE_RANK, assignableStaffRoles } from './staff-rbac.js';
import type { StaffRole } from './staff-rbac.js';

/**
 * Authentication for AVEX staff.
 *
 * Three rules separate this from merchant authentication, and each exists because a
 * staff credential reaches across every merchant rather than into one.
 *
 * There is no self-service signup. An account is created by an existing superadmin,
 * or by the bootstrap path when no staff exist at all. Nothing reachable over HTTP
 * can mint the first account once one exists.
 *
 * A second factor is mandatory, not optional. Login without an enrolled
 * authenticator does not return a usable session — it returns an enrolment
 * challenge and nothing else. A merchant may choose to accept the risk of a
 * password-only account; nobody gets to make that choice on other people's money.
 *
 * Sessions are short. A staff session left open on an unattended laptop is a
 * cross-tenant credential, so it expires in hours rather than weeks.
 */

export interface RequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface StaffAuthOptions {
  readonly sessionTtlMs: number;
}

/** Eight hours: one working day, so a session does not outlive the shift. */
export const DEFAULT_STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

type StaffLoginRefusal =
  | { readonly status: 'invalid' }
  | { readonly status: 'disabled'; readonly reason: string | null };

/**
 * What the first stage can return. Note the absence of a session: no combination of
 * a correct password alone produces one, and the type is where that is stated.
 */
export type StaffLoginStart =
  | {
      /** Password accepted, authenticator code still needed. */
      readonly status: 'mfa_required';
      readonly challengeToken: string;
    }
  | {
      /**
       * Password accepted but no authenticator is enrolled. The account cannot be
       * used until one is, so enrolment details come back here instead of a session.
       */
      readonly status: 'enrollment_required';
      readonly challengeToken: string;
      readonly totpSecret: string;
      readonly totpUri: string;
    }
  | StaffLoginRefusal;

/** What the second stage can return — the only path to a usable session. */
export type StaffLoginComplete =
  | { readonly status: 'ok'; readonly sessionToken: string; readonly expiresAt: Date }
  | StaffLoginRefusal;

export interface StaffPrincipal {
  readonly sessionId: string;
  readonly staffId: string;
  readonly email: string;
  readonly name: string;
  readonly role: StaffRole;
  readonly mfaSatisfiedAt: Date | null;
}

export class StaffAuthError extends Error {
  constructor(
    readonly code:
      | 'email_taken'
      | 'role_too_high'
      | 'not_found'
      | 'bootstrap_closed'
      | 'invalid_challenge'
      | 'weak_password',
    message: string,
  ) {
    super(message);
    this.name = 'StaffAuthError';
  }
}

/** Below this, a cross-tenant credential is not worth defending. */
const MIN_STAFF_PASSWORD_LENGTH = 14;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class StaffAuthService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: StaffAuthOptions = { sessionTtlMs: DEFAULT_STAFF_SESSION_TTL_MS },
  ) {}

  /**
   * Create the first superadmin, and only when no staff exist.
   *
   * Guarded by a count rather than by a flag or an environment variable: the
   * condition that makes this safe is "there is nobody who could have created it
   * properly", and the row count is that condition rather than a proxy for it. Once
   * one account exists this path is closed forever, including to itself.
   */
  async bootstrap(
    email: string,
    name: string,
    password: string,
    context: RequestContext = {},
  ): Promise<{ readonly staffId: string; readonly totpSecret: string; readonly totpUri: string }> {
    assertPasswordAcceptable(password);

    const [existing] = await this.db.select({ count: sql<number>`count(*)::int` }).from(staff);
    if ((existing?.count ?? 0) > 0) {
      throw new StaffAuthError(
        'bootstrap_closed',
        'Staff already exist; ask a superadmin to create the account.',
      );
    }

    const normalizedEmail = normalizeEmail(email);
    const secret = generateTotpSecret();
    const [row] = await this.db
      .insert(staff)
      .values({
        email: normalizedEmail,
        name,
        passwordHash: await hashPassword(password),
        role: 'superadmin' satisfies StaffRole,
        totpSecret: secret,
      })
      .returning({ id: staff.id });

    await this.audit.record({
      staffId: row!.id,
      action: 'staff.bootstrapped',
      targetType: 'staff',
      targetId: row!.id,
      metadata: { email: normalizedEmail, role: 'superadmin' },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { staffId: row!.id, totpSecret: secret, totpUri: totpUri(secret, normalizedEmail) };
  }

  /**
   * Create a staff account. The actor may not grant a role above their own, so a
   * compromised operator cannot promote itself by creating a superadmin.
   */
  async createStaff(
    actor: { readonly staffId: string; readonly role: StaffRole },
    email: string,
    name: string,
    password: string,
    role: StaffRole,
    context: RequestContext = {},
  ): Promise<{ readonly staffId: string; readonly totpSecret: string; readonly totpUri: string }> {
    assertPasswordAcceptable(password);

    if (!assignableStaffRoles(actor.role).includes(role)) {
      throw new StaffAuthError(
        'role_too_high',
        `A ${actor.role} cannot grant the ${role} role.`,
      );
    }

    const normalizedEmail = normalizeEmail(email);
    const [clash] = await this.db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.email, normalizedEmail))
      .limit(1);
    if (clash) throw new StaffAuthError('email_taken', 'That email already has a staff account.');

    const secret = generateTotpSecret();
    const [row] = await this.db
      .insert(staff)
      .values({
        email: normalizedEmail,
        name,
        passwordHash: await hashPassword(password),
        role,
        totpSecret: secret,
        createdByStaffId: actor.staffId,
      })
      .returning({ id: staff.id });

    await this.audit.record({
      staffId: actor.staffId,
      action: 'staff.created',
      targetType: 'staff',
      targetId: row!.id,
      metadata: { email: normalizedEmail, role },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { staffId: row!.id, totpSecret: secret, totpUri: totpUri(secret, normalizedEmail) };
  }

  /**
   * Step one of login: password only.
   *
   * Never returns a session. Whether the account has an authenticator or not, the
   * result is a challenge token, and only `completeLogin` can turn that into
   * something that authorises anything.
   */
  async login(
    email: string,
    password: string,
    context: RequestContext = {},
  ): Promise<StaffLoginStart> {
    const normalizedEmail = normalizeEmail(email);
    const [row] = await this.db
      .select()
      .from(staff)
      .where(eq(staff.email, normalizedEmail))
      .limit(1);

    // Hash against a throwaway even when the account is absent, so a missing
    // account and a wrong password take the same time to answer.
    const stored = row?.passwordHash ?? (await placeholderHash());
    const passwordOk = await verifyPassword(password, stored);
    if (!row || !passwordOk) return { status: 'invalid' };

    if (row.disabledAt !== null) {
      return { status: 'disabled', reason: row.disabledReason };
    }

    if (needsRehash(row.passwordHash)) {
      await this.db
        .update(staff)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(staff.id, row.id))
        .catch(() => undefined);
    }

    // The challenge is a session row with no MFA stamp. It carries no permission —
    // `requireStaff` refuses any session whose second factor is unproven — so the
    // same table can hold both stages without a second concept.
    const challenge = issueToken();
    await this.db.insert(staffSessions).values({
      staffId: row.id,
      tokenHash: challenge.hash,
      expiresAt: new Date(Date.now() + this.options.sessionTtlMs),
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    if (row.totpEnabledAt === null) {
      // No authenticator yet. Reuse the existing secret if enrolment was started
      // and abandoned, so a half-finished setup is resumable rather than stuck.
      let secret = row.totpSecret;
      if (secret === null) {
        secret = generateTotpSecret();
        await this.db.update(staff).set({ totpSecret: secret }).where(eq(staff.id, row.id));
      }
      return {
        status: 'enrollment_required',
        challengeToken: challenge.token,
        totpSecret: secret,
        totpUri: totpUri(secret, row.email),
      };
    }

    return { status: 'mfa_required', challengeToken: challenge.token };
  }

  /**
   * Step two: prove the authenticator code.
   *
   * Also the enrolment path — a correct code against a pending secret both confirms
   * the authenticator works and activates it, so there is no state where an account
   * is marked enrolled without a code having been produced from the secret.
   */
  async completeLogin(
    challengeToken: string,
    code: string,
    context: RequestContext = {},
  ): Promise<StaffLoginComplete> {
    const [row] = await this.db
      .select({
        sessionId: staffSessions.id,
        staffId: staff.id,
        secret: staff.totpSecret,
        enabledAt: staff.totpEnabledAt,
        disabledAt: staff.disabledAt,
        disabledReason: staff.disabledReason,
        expiresAt: staffSessions.expiresAt,
        revokedAt: staffSessions.revokedAt,
      })
      .from(staffSessions)
      .innerJoin(staff, eq(staff.id, staffSessions.staffId))
      .where(eq(staffSessions.tokenHash, hashToken(challengeToken)))
      .limit(1);

    if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw new StaffAuthError('invalid_challenge', 'That sign-in attempt has expired.');
    }
    if (row.disabledAt !== null) return { status: 'disabled', reason: row.disabledReason };
    if (row.secret === null) {
      throw new StaffAuthError('invalid_challenge', 'No authenticator is set up for this account.');
    }

    if (!verifyTotp(row.secret, code)) {
      return { status: 'invalid' };
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      if (row.enabledAt === null) {
        await tx.update(staff).set({ totpEnabledAt: now }).where(eq(staff.id, row.staffId));
      }
      await tx
        .update(staffSessions)
        .set({ mfaSatisfiedAt: now, lastSeenAt: now })
        .where(eq(staffSessions.id, row.sessionId));
    });

    await this.audit.record({
      staffId: row.staffId,
      action: row.enabledAt === null ? 'staff.totp_enrolled' : 'staff.signed_in',
      targetType: 'staff',
      targetId: row.staffId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    return {
      status: 'ok',
      sessionToken: challengeToken,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Resolve a session token into a principal, or null.
   *
   * A session whose second factor is unproven resolves to null rather than to a
   * principal with a flag. The merchant model returns a principal and lets the
   * permission check refuse it, which is right there because a half-authenticated
   * merchant still needs to reach the MFA endpoints. Staff have no such surface, so
   * "not fully authenticated" and "not authenticated" can be the same answer — and
   * one fewer state is one fewer way to get it wrong.
   */
  async resolveSession(token: string): Promise<StaffPrincipal | null> {
    const [row] = await this.db
      .select({
        sessionId: staffSessions.id,
        staffId: staff.id,
        email: staff.email,
        name: staff.name,
        role: staff.role,
        mfaSatisfiedAt: staffSessions.mfaSatisfiedAt,
        expiresAt: staffSessions.expiresAt,
        totpEnabledAt: staff.totpEnabledAt,
      })
      .from(staffSessions)
      .innerJoin(staff, eq(staff.id, staffSessions.staffId))
      .where(
        and(
          eq(staffSessions.tokenHash, hashToken(token)),
          isNull(staffSessions.revokedAt),
          isNull(staff.disabledAt),
        ),
      )
      .limit(1);

    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.mfaSatisfiedAt === null) return null;
    if (row.totpEnabledAt === null) return null;

    await this.db
      .update(staffSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(staffSessions.id, row.sessionId))
      .catch(() => undefined);

    return {
      sessionId: row.sessionId,
      staffId: row.staffId,
      email: row.email,
      name: row.name,
      role: row.role,
      mfaSatisfiedAt: row.mfaSatisfiedAt,
    };
  }

  /**
   * Re-prove the authenticator inside a live session, for an elevated action.
   *
   * Returns false rather than throwing on a bad code: a mistyped digit during a
   * confirmation is ordinary, not exceptional.
   */
  async reauthenticate(principal: StaffPrincipal, code: string): Promise<boolean> {
    const [row] = await this.db
      .select({ secret: staff.totpSecret })
      .from(staff)
      .where(eq(staff.id, principal.staffId))
      .limit(1);
    if (!row?.secret || !verifyTotp(row.secret, code)) return false;

    await this.db
      .update(staffSessions)
      .set({ mfaSatisfiedAt: new Date() })
      .where(eq(staffSessions.id, principal.sessionId));
    return true;
  }

  async signOut(principal: StaffPrincipal): Promise<void> {
    await this.db
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(eq(staffSessions.id, principal.sessionId));
  }

  /**
   * Disable a staff account and revoke every session it holds, in one transaction.
   *
   * Both halves matter: without the session revocation, a dismissed staff member
   * keeps cross-tenant access until their token expires.
   */
  async disableStaff(
    actor: { readonly staffId: string; readonly role: StaffRole },
    targetStaffId: string,
    reason: string,
    context: RequestContext = {},
  ): Promise<void> {
    const [target] = await this.db
      .select({ id: staff.id, role: staff.role, disabledAt: staff.disabledAt })
      .from(staff)
      .where(eq(staff.id, targetStaffId))
      .limit(1);
    if (!target) throw new StaffAuthError('not_found', 'No such staff account.');

    // Nobody may disable an account more privileged than their own.
    if (STAFF_ROLE_RANK[target.role] > STAFF_ROLE_RANK[actor.role]) {
      throw new StaffAuthError('role_too_high', `A ${actor.role} cannot disable a ${target.role}.`);
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(staff)
        .set({ disabledAt: now, disabledReason: reason })
        .where(eq(staff.id, targetStaffId));
      await tx
        .update(staffSessions)
        .set({ revokedAt: now })
        .where(and(eq(staffSessions.staffId, targetStaffId), isNull(staffSessions.revokedAt)));
    });

    await this.audit.record({
      staffId: actor.staffId,
      action: 'staff.disabled',
      targetType: 'staff',
      targetId: targetStaffId,
      metadata: { reason },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
  }
}

function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_STAFF_PASSWORD_LENGTH) {
    throw new StaffAuthError(
      'weak_password',
      `A staff password must be at least ${MIN_STAFF_PASSWORD_LENGTH} characters.`,
    );
  }
}

/**
 * A hash to compare against when no account matched, so the timing of a rejection
 * does not reveal whether the email exists. Computed once per process.
 */
let placeholder: Promise<string> | null = null;
function placeholderHash(): Promise<string> {
  placeholder ??= hashPassword('placeholder-for-constant-time-comparison');
  return placeholder;
}
