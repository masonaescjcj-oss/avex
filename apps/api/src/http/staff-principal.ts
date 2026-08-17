import type { AuditService } from '../domain/audit.js';
import type { StaffAuthService, StaffPrincipal } from '../domain/staff-auth.js';
import {
  StaffPermissionDeniedError,
  isAuditableStaffRead,
  staffAuthorize,
  staffCan,
  staffRequiresElevation,
} from '../domain/staff-rbac.js';
import type { StaffPermission } from '../domain/staff-rbac.js';

/**
 * Authentication and authorization for the admin panel.
 *
 * Kept in its own module rather than folded into `principal.ts` because the two
 * must not be able to satisfy each other. A merchant token reaching a staff route,
 * or the reverse, should fail on the first line — not on a permission check further
 * down that a future refactor might loosen.
 */

export class StaffUnauthenticatedError extends Error {
  constructor(message = 'staff authentication required') {
    super(message);
    this.name = 'StaffUnauthenticatedError';
  }
}

export class StaffTwoFactorRequiredError extends Error {
  constructor(readonly permission: StaffPermission) {
    super(`staff permission ${permission} requires a proven second factor`);
    this.name = 'StaffTwoFactorRequiredError';
  }
}

/**
 * Resolve an `Authorization: Bearer …` value into a staff principal.
 *
 * Tokens beginning `ak_` are merchant API keys and are refused outright. An API key
 * is a headless credential with no second factor behind it; the admin panel is
 * exactly where such a thing must not work, so the rejection is explicit here
 * rather than left to a scope check that happens to fail.
 */
export async function resolveStaffPrincipal(
  staffAuth: StaffAuthService,
  header: string | undefined,
): Promise<StaffPrincipal | null> {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) return null;
  if (token.startsWith('ak_')) return null;

  return staffAuth.resolveSession(token);
}

export interface StaffRequestContext {
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

/**
 * Authorise a staff action, and record it when it touches an identified merchant.
 *
 * The audit write is inside this function on purpose. A route that reads a
 * merchant's data has to pass through here to get permission, so the access cannot
 * be logged in one place and performed in another — the only way to skip the log is
 * to skip the authorization, which fails.
 *
 * Reads are recorded before the handler runs rather than after it succeeds. If a
 * query throws halfway through, the staff member has still seen whatever came back
 * first, and an access that produced an error is exactly the kind worth having a
 * record of.
 */
export async function requireStaffPermission(
  audit: AuditService,
  principal: StaffPrincipal | null,
  permission: StaffPermission,
  options: {
    readonly targetType?: string | null | undefined;
    readonly targetId?: string | null | undefined;
    readonly context?: StaffRequestContext | undefined;
  } = {},
): Promise<StaffPrincipal> {
  if (principal === null) throw new StaffUnauthenticatedError();

  /**
   * Role first, then the second factor — the same ordering as the merchant model,
   * for the same two reasons. Someone whose role cannot perform an action should be
   * told that rather than sent to re-confirm an authenticator that would change
   * nothing, and answering "confirm with your authenticator" reveals that the
   * action is elevation-gated to someone with no business knowing it exists.
   */
  if (!staffCan(principal.role, permission)) {
    throw new StaffPermissionDeniedError(permission, principal.role);
  }

  if (staffRequiresElevation(permission) && principal.mfaSatisfiedAt === null) {
    throw new StaffTwoFactorRequiredError(permission);
  }

  staffAuthorize(
    { role: principal.role, mfaSatisfiedAt: principal.mfaSatisfiedAt?.getTime() ?? null },
    permission,
  );

  const targetId = options.targetId ?? null;
  if (isAuditableStaffRead(permission, targetId)) {
    /**
     * The subject is recorded in `targetId`, never in `organizationId`.
     *
     * `organizationId` carries a foreign key, so writing an id that does not exist
     * fails the insert — and this runs before the handler has established that the
     * merchant is real. Attributing the row through `targetId`, which is plain text
     * for exactly this reason, means an access attempt against an unknown id is
     * recorded rather than turned into a 500. Probing for merchant ids is precisely
     * the behaviour worth having a record of.
     *
     * `searchAudit` matches both columns when filtering by merchant, so these rows
     * still turn up under the merchant they were about.
     */
    await audit.record({
      staffId: principal.staffId,
      action: 'staff.read',
      targetType: options.targetType ?? null,
      targetId,
      metadata: { permission },
      ip: options.context?.ip ?? null,
      userAgent: options.context?.userAgent ?? null,
    });
  }

  return principal;
}
