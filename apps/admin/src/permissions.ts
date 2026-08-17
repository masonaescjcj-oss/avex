/**
 * What the panel shows, derived from what the server said this staff member may do.
 *
 * The panel renders from the permission list returned by `/admin/me` rather than
 * from the role name. Two reasons, and the second is the important one.
 *
 * Deriving from the role would mean the permission model existed twice — once in
 * `staff-rbac.ts` and once here — and the copy would drift the first time a
 * permission moved between roles. And hiding a control is presentation, not security:
 * every route checks the permission again server-side, so this module's job is to
 * avoid offering an action that will be refused, not to prevent it.
 */

export type StaffPermission = string;

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly marker: string;
  /** Absent means everyone signed in sees it. */
  readonly requires?: StaffPermission;
}

/**
 * The panel's sections, in the order the work happens.
 *
 * Health is first on purpose. It is the only screen that answers "is anything wrong
 * right now", and a panel that opens on a merchant list invites an operator to start
 * with whatever they were last asked about rather than with whatever is broken.
 */
export const NAV: readonly NavItem[] = [
  { id: 'health', label: 'Health', marker: '💚', requires: 'health:read' },
  { id: 'merchants', label: 'Merchants', marker: '🏪', requires: 'merchant:read' },
  { id: 'unmatched', label: 'Unmatched', marker: '🧩', requires: 'payment:read' },
  { id: 'review', label: 'Contracts', marker: '🔍', requires: 'contract:read' },
  { id: 'settlements', label: 'Settlements', marker: '⛽', requires: 'settlement:read' },
  { id: 'audit', label: 'Audit', marker: '📜', requires: 'audit:read' },
];

export function visibleNav(permissions: readonly StaffPermission[]): readonly NavItem[] {
  const held = new Set(permissions);
  return NAV.filter((item) => item.requires === undefined || held.has(item.requires));
}

/**
 * The first section this staff member can actually open.
 *
 * A support user has no `settlement:read`, so landing them on a section they cannot
 * see would show an empty shell and read as a broken panel.
 */
export function defaultSection(permissions: readonly StaffPermission[]): string | null {
  return visibleNav(permissions)[0]?.id ?? null;
}

export function can(permissions: readonly StaffPermission[], permission: StaffPermission): boolean {
  return permissions.includes(permission);
}

/**
 * Whether an action needs the authenticator re-proven before it will be accepted.
 *
 * Mirrors `STAFF_ELEVATION_REQUIRED` on the server. Duplicated deliberately and
 * narrowly: the panel needs it to ask for a code *before* submitting, so an operator
 * who has typed a 500-character review note does not lose it to a 403. The server
 * remains the authority — if this list is wrong, the request is refused, which is the
 * safe direction for the copy to be stale in.
 */
const ELEVATED: ReadonlySet<StaffPermission> = new Set([
  'staff:write',
  'asset_list:write',
  'contract:decide',
  'payment:reassign',
]);

export function needsElevation(permission: StaffPermission): boolean {
  return ELEVATED.has(permission);
}

/** The server's window is two minutes; ask again a little early to avoid a race. */
export const ELEVATION_ASK_AFTER_MS = 90 * 1000;

/**
 * Whether the second factor is fresh enough to attempt an elevated action.
 *
 * Deliberately conservative: an unparseable or absent timestamp counts as stale, so
 * the panel asks for a code rather than assuming it is still good.
 */
export function elevationIsFresh(
  mfaSatisfiedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!mfaSatisfiedAt) return false;
  const at = Date.parse(mfaSatisfiedAt);
  if (Number.isNaN(at)) return false;
  return now - at < ELEVATION_ASK_AFTER_MS;
}
