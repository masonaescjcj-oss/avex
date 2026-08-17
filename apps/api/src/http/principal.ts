import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { apiKeys, memberships, organizations } from '../db/schema.js';
import { hashToken } from '../auth/tokens.js';
import type { ApiKeyMode } from '../auth/tokens.js';
import type { AuthService, SessionPrincipal } from '../domain/auth-service.js';
import type { Permission, Role } from '../domain/rbac.js';
import { PermissionDeniedError, authorize, can, requiresElevation } from '../domain/rbac.js';

/**
 * Who is making a request.
 *
 * A human in a browser and a server holding an API key are authorised through the
 * same permission model but reach it differently: the human's role comes from
 * their membership in the organisation named by the route, while a key is bound to
 * one organisation and carries an explicit scope list.
 */
export type Principal =
  | { readonly kind: 'session'; readonly session: SessionPrincipal }
  | {
      readonly kind: 'api_key';
      readonly apiKeyId: string;
      readonly organizationId: string;
      readonly mode: ApiKeyMode;
      readonly scopes: readonly string[];
    };

export class UnauthenticatedError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class MfaIncompleteError extends Error {
  constructor() {
    super('second factor required to continue');
    this.name = 'MfaIncompleteError';
  }
}

export class OrganizationSuspendedError extends Error {
  constructor(readonly reason: string | null) {
    super('organization is suspended');
    this.name = 'OrganizationSuspendedError';
  }
}

export class NotAMemberError extends Error {
  constructor() {
    super('not a member of this organization');
    this.name = 'NotAMemberError';
  }
}

/** Resolve an `Authorization: Bearer …` value into a principal. */
export async function resolvePrincipal(
  db: Database,
  auth: AuthService,
  header: string | undefined,
): Promise<Principal | null> {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return null;

  if (token.startsWith('ak_')) {
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) return null;

    // Best-effort last-used stamp; a failure here must not deny a valid request.
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);

    return {
      kind: 'api_key',
      apiKeyId: row.id,
      organizationId: row.organizationId,
      mode: row.mode,
      scopes: row.scopes,
    };
  }

  const session = await auth.resolveSession(token);
  return session ? { kind: 'session', session } : null;
}

export interface OrganizationAccess {
  readonly organizationId: string;
  readonly role: Role | null;
  readonly principal: Principal;
}

/**
 * Establish that the principal may act within an organisation, and refuse a
 * suspended one before any handler runs.
 *
 * Tenancy is enforced here rather than in each handler: a route that forgets to
 * scope its query is a data leak, so the only way to obtain an organisation id
 * downstream is to have passed through this check.
 */
export async function requireOrganizationAccess(
  db: Database,
  principal: Principal,
  organizationId: string,
): Promise<OrganizationAccess> {
  const [organization] = await db
    .select({ id: organizations.id, suspendedAt: organizations.suspendedAt, suspendedReason: organizations.suspendedReason })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new NotAMemberError();
  if (organization.suspendedAt !== null) {
    throw new OrganizationSuspendedError(organization.suspendedReason);
  }

  if (principal.kind === 'api_key') {
    if (principal.organizationId !== organizationId) throw new NotAMemberError();
    return { organizationId, role: null, principal };
  }

  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, principal.session.userId),
        isNull(memberships.revokedAt),
      ),
    )
    .limit(1);
  if (!membership) throw new NotAMemberError();

  return { organizationId, role: membership.role, principal };
}

/**
 * Authorise an action. Throws on refusal so a forgotten check is a visible
 * absence rather than an ignored return value.
 */
export function requirePermission(access: OrganizationAccess, permission: Permission): void {
  if (access.principal.kind === 'api_key') {
    // A key exercises only what it was granted. Elevation is a property of a
    // human session, so permissions that demand it are never available to a key.
    if (!access.principal.scopes.includes(permission)) {
      throw new ScopeMissingError(permission);
    }
    return;
  }

  const { session } = access.principal;
  if (!session.mfaComplete) throw new MfaIncompleteError();

  const role = access.role!;

  /**
   * Role first, then the second factor.
   *
   * Order matters for two reasons. A user whose role cannot perform an action
   * should be told that, not sent to enrol an authenticator that would change
   * nothing. And answering "set up two-factor" reveals that the action is
   * elevation-gated — a small disclosure, but to someone with no business knowing
   * the action exists.
   */
  if (!can(role, permission)) {
    throw new PermissionDeniedError(permission, role);
  }

  // An action that must be confirmed with an authenticator is impossible without
  // one. Say so plainly rather than reporting a generic elevation failure the
  // user has no way to resolve.
  if (requiresElevation(permission) && !session.totpEnabled) {
    throw new TwoFactorEnrollmentRequiredError(permission);
  }

  authorize(
    { role, mfaSatisfiedAt: session.mfaSatisfiedAt?.getTime() ?? null },
    permission,
  );
}

/**
 * Raised when an elevated action is attempted by a user who has never enrolled a
 * second factor. Distinct from `ElevationRequiredError`, where the user has an
 * authenticator and merely needs to use it again.
 */
export class TwoFactorEnrollmentRequiredError extends Error {
  constructor(readonly permission: Permission) {
    super(`permission ${permission} requires an enrolled second factor`);
    this.name = 'TwoFactorEnrollmentRequiredError';
  }
}

export class ScopeMissingError extends Error {
  constructor(readonly permission: Permission) {
    super(`api key lacks scope ${permission}`);
    this.name = 'ScopeMissingError';
  }
}
