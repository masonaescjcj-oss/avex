import { randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  emailTokens,
  memberships,
  organizations,
  recoveryCodes,
  sessions,
  users,
} from '../db/schema.js';
import { CURRENT_PARAMS, hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from '../auth/totp.js';
import { hashToken, issueToken } from '../auth/tokens.js';
import type { AuditService } from './audit.js';
import type { Role } from './rbac.js';

/**
 * A stored hash that no password matches, used to keep the work done by a failed
 * login independent of whether the email exists. Without it, response timing
 * reveals which addresses have accounts.
 */
const TIMING_DECOY = [
  'scrypt',
  CURRENT_PARAMS.cost,
  CURRENT_PARAMS.blockSize,
  CURRENT_PARAMS.parallelism,
  randomBytes(16).toString('base64url'),
  randomBytes(32).toString('base64url'),
].join('$');

export interface RequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface AuthServiceOptions {
  readonly sessionTtlMs: number;
  readonly emailTokenTtlMs: number;
}

export interface SignupResult {
  readonly userId: string;
  readonly organizationId: string;
  /** Emailed to the user. Returned here so the caller can hand it to the mailer. */
  readonly emailVerificationToken: string;
}

export type LoginOutcome =
  | { readonly status: 'ok'; readonly sessionToken: string; readonly expiresAt: Date }
  | {
      /**
       * Credentials were correct but the second factor is outstanding. The session
       * exists and its token is returned, but it authorises nothing beyond
       * completing the challenge.
       */
      readonly status: 'mfa_required';
      readonly sessionToken: string;
      readonly expiresAt: Date;
    }
  | { readonly status: 'invalid' }
  | { readonly status: 'disabled' };

export interface SessionPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly totpEnabled: boolean;
  /** False while a second factor is enrolled but not yet proven in this session. */
  readonly mfaComplete: boolean;
  readonly mfaSatisfiedAt: Date | null;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly options: AuthServiceOptions,
  ) {}

  /**
   * Create a user together with the organisation they own.
   *
   * Every user belongs to at least one organisation, because an account with no
   * organisation has nothing it can do and creates an empty state that every
   * later query would have to handle.
   */
  async signup(
    email: string,
    password: string,
    organizationName: string,
    context: RequestContext = {},
  ): Promise<SignupResult> {
    const normalizedEmail = normalizeEmail(email);

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (existing.length > 0) throw new EmailAlreadyRegisteredError();

    const passwordHash = await hashPassword(password);
    const verification = issueToken();

    const result = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: normalizedEmail, passwordHash })
        .returning({ id: users.id });

      const [organization] = await tx
        .insert(organizations)
        .values({ name: organizationName, slug: await uniqueSlug(tx, organizationName) })
        .returning({ id: organizations.id });

      await tx.insert(memberships).values({
        organizationId: organization!.id,
        userId: user!.id,
        role: 'owner' satisfies Role,
      });

      await tx.insert(emailTokens).values({
        userId: user!.id,
        tokenHash: verification.hash,
        purpose: 'verify_email',
        expiresAt: new Date(Date.now() + this.options.emailTokenTtlMs),
      });

      return { userId: user!.id, organizationId: organization!.id };
    });

    await this.audit.record({
      ...context,
      organizationId: result.organizationId,
      userId: result.userId,
      action: 'user.signed_up',
      targetType: 'user',
      targetId: result.userId,
      metadata: { email: normalizedEmail, organizationName },
    });

    return { ...result, emailVerificationToken: verification.token };
  }

  async verifyEmail(token: string, context: RequestContext = {}): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, hashToken(token)), isNull(emailTokens.consumedAt)))
      .limit(1);

    if (!row || row.purpose !== 'verify_email' || row.expiresAt.getTime() < Date.now()) {
      return false;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(emailTokens)
        .set({ consumedAt: new Date() })
        .where(eq(emailTokens.id, row.id));
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, row.userId));
    });

    await this.audit.record({
      ...context,
      userId: row.userId,
      action: 'user.email_verified',
      targetType: 'user',
      targetId: row.userId,
    });
    return true;
  }

  async login(
    email: string,
    password: string,
    context: RequestContext = {},
  ): Promise<LoginOutcome> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);

    // Always perform the derivation, so a missing account costs the same as a
    // wrong password.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? TIMING_DECOY);

    if (!user || !passwordOk) {
      if (user) {
        await this.audit.record({
          ...context,
          userId: user.id,
          action: 'user.login_failed',
          targetType: 'user',
          targetId: user.id,
        });
      }
      return { status: 'invalid' };
    }

    if (user.disabledAt !== null) return { status: 'disabled' };

    // Opportunistically upgrade a hash left behind by older parameters.
    if (needsRehash(user.passwordHash)) {
      await this.db
        .update(users)
        .set({ passwordHash: await hashPassword(password) })
        .where(eq(users.id, user.id));
    }

    const totpEnabled = user.totpEnabledAt !== null;
    const session = issueToken();
    const expiresAt = new Date(Date.now() + this.options.sessionTtlMs);

    await this.db.insert(sessions).values({
      userId: user.id,
      tokenHash: session.hash,
      /**
       * Always null at login, including for users with no authenticator enrolled.
       *
       * This column means "a second factor was proven", not "login is finished".
       * Stamping it for users without one would hand them elevation for free and
       * make the whole mechanism decorative for precisely the accounts least
       * protected. Such users can still use the application — `mfaComplete`
       * accounts for having nothing to prove — but elevated actions require
       * enrolling first.
       */
      mfaSatisfiedAt: null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      expiresAt,
    });

    await this.audit.record({
      ...context,
      userId: user.id,
      action: totpEnabled ? 'user.login_awaiting_mfa' : 'user.logged_in',
      targetType: 'user',
      targetId: user.id,
    });

    return totpEnabled
      ? { status: 'mfa_required', sessionToken: session.token, expiresAt }
      : { status: 'ok', sessionToken: session.token, expiresAt };
  }

  /** Resolve a bearer session token, or null if it is unknown, expired or revoked. */
  async resolveSession(token: string): Promise<SessionPrincipal | null> {
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        mfaSatisfiedAt: sessions.mfaSatisfiedAt,
        userId: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        totpEnabledAt: users.totpEnabledAt,
        disabledAt: users.disabledAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);

    if (!row) return null;
    if (row.revokedAt !== null || row.disabledAt !== null) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;

    await this.db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.sessionId));

    const totpEnabled = row.totpEnabledAt !== null;
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      emailVerified: row.emailVerifiedAt !== null,
      totpEnabled,
      mfaComplete: !totpEnabled || row.mfaSatisfiedAt !== null,
      mfaSatisfiedAt: row.mfaSatisfiedAt,
    };
  }

  /** Begin enrolment. The secret is not active until `confirmTotp` succeeds. */
  async beginTotpEnrollment(
    userId: string,
    email: string,
  ): Promise<{ secret: string; uri: string }> {
    const secret = generateTotpSecret();
    await this.db.update(users).set({ totpSecret: secret }).where(eq(users.id, userId));
    return { secret, uri: totpUri(secret, email) };
  }

  /**
   * Complete enrolment by proving possession of the authenticator, and issue
   * recovery codes. Returned in plaintext once; only hashes are kept.
   */
  async confirmTotpEnrollment(
    userId: string,
    code: string,
    context: RequestContext = {},
  ): Promise<string[] | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.totpSecret) return null;
    if (!verifyTotp(user.totpSecret, code)) return null;

    const codes = generateRecoveryCodes();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ totpEnabledAt: now }).where(eq(users.id, userId));
      // Replace any codes from a previous enrolment.
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(codes.map((code) => ({ userId, codeHash: hashToken(code) })));
      // Existing sessions have not proven this new factor.
      await tx
        .update(sessions)
        .set({ mfaSatisfiedAt: null })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });

    await this.audit.record({
      ...context,
      userId,
      action: 'user.totp_enabled',
      targetType: 'user',
      targetId: userId,
    });
    return codes;
  }

  /**
   * Prove the second factor for a session — both to complete a login and to
   * elevate an existing session before a dangerous action.
   */
  async satisfyMfa(
    principal: SessionPrincipal,
    code: string,
    context: RequestContext = {},
  ): Promise<boolean> {
    const [user] = await this.db
      .select({ totpSecret: users.totpSecret })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);
    if (!user?.totpSecret) return false;

    const byTotp = verifyTotp(user.totpSecret, code);
    const byRecovery = byTotp ? false : await this.consumeRecoveryCode(principal.userId, code);
    if (!byTotp && !byRecovery) {
      await this.audit.record({
        ...context,
        userId: principal.userId,
        action: 'user.mfa_failed',
        targetType: 'session',
        targetId: principal.sessionId,
      });
      return false;
    }

    await this.db
      .update(sessions)
      .set({ mfaSatisfiedAt: new Date() })
      .where(eq(sessions.id, principal.sessionId));

    await this.audit.record({
      ...context,
      userId: principal.userId,
      action: byRecovery ? 'user.mfa_recovery_code_used' : 'user.mfa_satisfied',
      targetType: 'session',
      targetId: principal.sessionId,
    });
    return true;
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = code.trim().toUpperCase();
    const [row] = await this.db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, hashToken(normalized)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .limit(1);
    if (!row) return false;

    await this.db
      .update(recoveryCodes)
      .set({ usedAt: new Date() })
      .where(eq(recoveryCodes.id, row.id));
    return true;
  }

  async logout(principal: SessionPrincipal, context: RequestContext = {}): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, principal.sessionId));
    await this.audit.record({
      ...context,
      userId: principal.userId,
      action: 'user.logged_out',
      targetType: 'session',
      targetId: principal.sessionId,
    });
  }

  /** Revoke every session but the current one — the "sign out other devices" action. */
  async revokeOtherSessions(principal: SessionPrincipal): Promise<void> {
    const active = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, principal.userId), isNull(sessions.revokedAt)));

    const others = active.filter((row) => row.id !== principal.sessionId).map((row) => row.id);
    for (const id of others) {
      await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
    }
  }
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Organisation names are often non-Latin; fall back rather than produce "".
  return base.length > 0 ? base : `org-${randomBytes(4).toString('hex')}`;
}

async function uniqueSlug(
  tx: { select: Database['select'] },
  name: string,
): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    const clash = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (clash.length === 0) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}
