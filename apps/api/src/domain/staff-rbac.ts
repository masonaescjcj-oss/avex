/**
 * Roles and permissions for AVEX staff — the admin panel's authorization model.
 *
 * This is deliberately a separate model from the merchant one in `rbac.ts`, not an
 * extra role bolted onto it. A merchant's `owner` is powerful inside one
 * organisation; a staff `operator` is powerful across all of them. Collapsing the
 * two would mean one permission table where a mistake in a merchant-facing role
 * could grant cross-tenant reach, which is exactly the mistake worth making
 * structurally impossible.
 *
 * Three roles, nested, mirroring the merchant model's shape so there is one idea to
 * learn rather than two:
 *
 *   support   — read across merchants; resolves questions, changes nothing
 *   operator  — support, plus the interventions that keep the system running
 *   superadmin— operator, plus anything that changes what the platform trusts
 *
 * The line between `operator` and `superadmin` is worth naming. An operator acts on
 * one merchant at a time and their mistakes are bounded to that merchant. A
 * superadmin changes things that apply to everyone — who else is staff, and which
 * assets the whole platform accepts. Approving a counterfeit asset globally is the
 * single most damaging action available in this panel, so it sits above the role
 * used for day-to-day work.
 */

export const STAFF_ROLES = ['support', 'operator', 'superadmin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_PERMISSIONS = [
  /** List merchants and open one. Reads of a named merchant are audited. */
  'merchant:read',
  /** Immediate suspension, and reinstatement. */
  'merchant:suspend',
  /** See a submitted contract and the automatic probe findings. */
  'contract:read',
  /** Approve or reject a submitted contract, for one merchant. */
  'contract:decide',
  /** Queue depth, gas, deferrals, stuck transactions, gas runway. */
  'settlement:read',
  /** Cross-merchant invoice and payment lookup. */
  'payment:read',
  /** Attach an unmatched payment to an invoice, or mark it for return. */
  'payment:reassign',
  /** RPC, oracle, watcher lag, webhook error rate. */
  'health:read',
  /** The audit trail, across all merchants. */
  'audit:read',
  /** Re-send a webhook a merchant did not receive. */
  'webhook:replay',
  'staff:read',
  /** Create, disable, and re-role other staff. */
  'staff:write',
  /** See the platform's asset catalogue and which merchants use each entry. */
  'asset_list:read',
  /** Add to or flag the global curated asset list — affects every merchant. */
  'asset_list:write',
  /** Open or close a chain or asset by hand, outside the automatic breakers. */
  'breaker:write',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

const SUPPORT: readonly StaffPermission[] = [
  'merchant:read',
  'contract:read',
  'settlement:read',
  'payment:read',
  'health:read',
  'audit:read',
  'staff:read',
  /**
   * Reading the catalogue is a support action.
   *
   * "Why can't I enable USDC on Solana" is a question support gets, and the answer is on
   * this list. Withholding it would mean escalating a question whose answer is one screen
   * away, while the write that actually matters stays superadmin-only.
   */
  'asset_list:read',
];

const OPERATOR: readonly StaffPermission[] = [
  ...SUPPORT,
  'merchant:suspend',
  'contract:decide',
  'payment:reassign',
  'webhook:replay',
  'breaker:write',
];

const SUPERADMIN: readonly StaffPermission[] = [
  ...OPERATOR,
  'staff:write',
  'asset_list:write',
];

const STAFF_ROLE_PERMISSIONS: Readonly<Record<StaffRole, ReadonlySet<StaffPermission>>> = {
  support: new Set(SUPPORT),
  operator: new Set(OPERATOR),
  superadmin: new Set(SUPERADMIN),
};

export function staffCan(role: StaffRole, permission: StaffPermission): boolean {
  return STAFF_ROLE_PERMISSIONS[role].has(permission);
}

export function staffPermissionsFor(role: StaffRole): readonly StaffPermission[] {
  return [...STAFF_ROLE_PERMISSIONS[role]];
}

/**
 * Staff actions that need the second factor proven again, inside a valid session.
 *
 * The test applied here is not "is this important" — everything in this panel is —
 * but "would an attacker holding a stolen staff session want to do it, and is it
 * hard to undo". Suspending a merchant is loud and reversible in one click, so it
 * is not on this list. Approving an asset for every merchant, or granting someone
 * else staff access, is quiet and durable, so it is.
 */
const STAFF_ELEVATION_REQUIRED: ReadonlySet<StaffPermission> = new Set<StaffPermission>([
  'staff:write',
  'asset_list:write',
  'contract:decide',
  'payment:reassign',
]);

export function staffRequiresElevation(permission: StaffPermission): boolean {
  return STAFF_ELEVATION_REQUIRED.has(permission);
}

/**
 * Elevation window for staff, shorter than the merchant one.
 *
 * A merchant works in their dashboard for long stretches and a five-minute window
 * is a fair trade. A staff member acting on someone else's money should be
 * re-confirming often, and the cost of doing so falls on us rather than a customer.
 */
export const STAFF_ELEVATION_WINDOW_MS = 2 * 60 * 1000;

export const STAFF_ROLE_RANK: Readonly<Record<StaffRole, number>> = {
  support: 0,
  operator: 1,
  superadmin: 2,
};

/**
 * Roles a staff member may assign. Nobody may grant a role above their own, so a
 * compromised operator account cannot promote itself by way of a new account.
 */
export function assignableStaffRoles(actorRole: StaffRole): readonly StaffRole[] {
  return STAFF_ROLES.filter((role) => STAFF_ROLE_RANK[role] <= STAFF_ROLE_RANK[actorRole]);
}

export class StaffPermissionDeniedError extends Error {
  constructor(
    readonly permission: StaffPermission,
    readonly role: StaffRole,
  ) {
    super(`staff role ${role} lacks permission ${permission}`);
    this.name = 'StaffPermissionDeniedError';
  }
}

export class StaffElevationRequiredError extends Error {
  constructor(readonly permission: StaffPermission) {
    super(`staff permission ${permission} requires a fresh second factor`);
    this.name = 'StaffElevationRequiredError';
  }
}

export interface StaffAuthorizeContext {
  readonly role: StaffRole;
  readonly mfaSatisfiedAt: number | null;
  readonly now?: number;
}

/**
 * The single staff authorization entry point. Throws rather than returning a
 * boolean, so a forgotten check is a visible absence rather than an ignored value.
 */
export function staffAuthorize(
  context: StaffAuthorizeContext,
  permission: StaffPermission,
): void {
  if (!staffCan(context.role, permission)) {
    throw new StaffPermissionDeniedError(permission, context.role);
  }

  if (staffRequiresElevation(permission)) {
    const now = context.now ?? Date.now();
    const satisfiedAt = context.mfaSatisfiedAt;
    if (satisfiedAt === null || now - satisfiedAt > STAFF_ELEVATION_WINDOW_MS) {
      throw new StaffElevationRequiredError(permission);
    }
  }
}

/**
 * Reads that name one merchant are recorded in the audit trail; reads that do not
 * are noise.
 *
 * Opening a specific merchant's detail page is an access to their data and a
 * question someone may later have to answer for. Paging through a list of merchant
 * names is not, and logging it would bury the accesses that matter under thousands
 * of rows nobody reads.
 */
export function isAuditableStaffRead(permission: StaffPermission, targetId: string | null): boolean {
  if (targetId === null) return false;
  return permission === 'merchant:read' || permission === 'payment:read';
}
