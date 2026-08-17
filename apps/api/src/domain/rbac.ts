/**
 * Roles and permissions.
 *
 * The interesting decision here is that `payout_address:write` belongs to the
 * owner alone, not to admins. Everything else an admin can do is recoverable;
 * changing where money is sent is not. Narrowing that one permission to a single
 * role means a compromised admin account cannot redirect a merchant's revenue.
 */

export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:read',
  'org:update',
  'org:delete',
  'member:read',
  'member:invite',
  'member:remove',
  'member:role_change',
  /** Change where settled funds are sent. Owner only, and always elevated. */
  'payout_address:write',
  'payout_address:read',
  'asset:read',
  /** Enable chains and tokens, submit a custom contract for review. */
  'asset:write',
  'invoice:read',
  'invoice:create',
  'invoice:refund',
  'apikey:read',
  'apikey:write',
  'webhook:read',
  'webhook:write',
  'settings:read',
  'settings:write',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: readonly Permission[] = [
  'org:read',
  'member:read',
  'payout_address:read',
  'asset:read',
  'invoice:read',
  'apikey:read',
  'webhook:read',
  'settings:read',
  'audit:read',
];

const DEVELOPER: readonly Permission[] = [
  ...READ_ONLY,
  'invoice:create',
  'apikey:write',
  'webhook:write',
];

const ADMIN: readonly Permission[] = [
  ...DEVELOPER,
  'org:update',
  'member:invite',
  'member:remove',
  'asset:write',
  'invoice:refund',
  'settings:write',
];

const OWNER: readonly Permission[] = [
  ...ADMIN,
  'org:delete',
  'member:role_change',
  'payout_address:write',
];

const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer: new Set(READ_ONLY),
  developer: new Set(DEVELOPER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * Permissions that require a fresh second factor even inside a valid session,
 * regardless of role.
 *
 * A stolen session cookie is a realistic threat; re-proving possession of the
 * authenticator at the moment of a dangerous action is what makes that theft
 * insufficient on its own.
 */
const ELEVATION_REQUIRED: ReadonlySet<Permission> = new Set<Permission>([
  'payout_address:write',
  'apikey:write',
  'member:role_change',
  'member:remove',
  'org:delete',
]);

export function requiresElevation(permission: Permission): boolean {
  return ELEVATION_REQUIRED.has(permission);
}

/** How recently the second factor must have been proven, for elevated actions. */
export const ELEVATION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Permissions whose effect is deferred rather than immediate.
 *
 * A payout address change is queued and applied after a delay, with everyone in
 * the organisation notified. The delay is the actual protection: it converts a
 * silent theft into something the merchant has a window to notice and cancel.
 */
const DELAYED: ReadonlyMap<Permission, number> = new Map<Permission, number>([
  ['payout_address:write', 24 * 60 * 60 * 1000],
]);

export function delayFor(permission: Permission): number | null {
  return DELAYED.get(permission) ?? null;
}

/** Privilege order, least to most. `ROLES` is declared owner-first for the enum. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
};

/** Roles ordered least to most privileged — the order a role picker should show. */
export const ROLES_ASCENDING: readonly Role[] = [...ROLES].sort(
  (a, b) => ROLE_RANK[a] - ROLE_RANK[b],
);

/** Roles an actor may assign — nobody may grant a role above their own. */
export function assignableRoles(actorRole: Role): readonly Role[] {
  return ROLES_ASCENDING.filter((role) => ROLE_RANK[role] <= ROLE_RANK[actorRole]);
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: Role,
  ) {
    super(`role ${role} lacks permission ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

export class ElevationRequiredError extends Error {
  constructor(readonly permission: Permission) {
    super(`permission ${permission} requires a fresh second factor`);
    this.name = 'ElevationRequiredError';
  }
}

export interface AuthorizeContext {
  readonly role: Role;
  /** When the second factor was last proven in this session, if ever. */
  readonly mfaSatisfiedAt: number | null;
  readonly now?: number;
}

/**
 * The single authorization entry point. Throws rather than returning a boolean so
 * a forgotten check cannot silently pass — a missing `authorize` call is a
 * visible absence, while an ignored return value is not.
 */
export function authorize(context: AuthorizeContext, permission: Permission): void {
  if (!can(context.role, permission)) {
    throw new PermissionDeniedError(permission, context.role);
  }

  if (requiresElevation(permission)) {
    const now = context.now ?? Date.now();
    const satisfiedAt = context.mfaSatisfiedAt;
    if (satisfiedAt === null || now - satisfiedAt > ELEVATION_WINDOW_MS) {
      throw new ElevationRequiredError(permission);
    }
  }
}
