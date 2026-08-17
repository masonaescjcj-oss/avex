import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  STAFF_ELEVATION_WINDOW_MS,
  STAFF_PERMISSIONS,
  STAFF_ROLES,
  STAFF_ROLE_RANK,
  StaffElevationRequiredError,
  StaffPermissionDeniedError,
  assignableStaffRoles,
  isAuditableStaffRead,
  staffAuthorize,
  staffCan,
  staffPermissionsFor,
  staffRequiresElevation,
} from './staff-rbac.js';
import type { StaffPermission, StaffRole } from './staff-rbac.js';

/**
 * These tests pin the properties of the model, not its current contents.
 *
 * The distinction matters: a test asserting "operator has exactly these eleven
 * permissions" has to be edited every time a feature is added, and a test that gets
 * edited on every change stops being read. A test asserting "no role may grant a
 * role above itself" survives every addition and fails only on a real mistake.
 */

test('roles nest — each role has every permission of the one below it', () => {
  const ordered = [...STAFF_ROLES].sort((a, b) => STAFF_ROLE_RANK[a] - STAFF_ROLE_RANK[b]);

  for (let i = 1; i < ordered.length; i++) {
    const lower = staffPermissionsFor(ordered[i - 1]!);
    const higher = new Set(staffPermissionsFor(ordered[i]!));
    for (const permission of lower) {
      assert.ok(
        higher.has(permission),
        `${ordered[i]} is missing ${permission}, which ${ordered[i - 1]} has`,
      );
    }
  }
});

test('support can read but cannot change anything', () => {
  // The property under test is that no support permission mutates state. Naming the
  // write permissions rather than the read ones means a newly added write
  // permission fails here by default, which is the safer direction to be wrong in.
  const writes: readonly StaffPermission[] = [
    'merchant:suspend',
    'contract:decide',
    'payment:reassign',
    'webhook:replay',
    'staff:write',
    'asset_list:write',
    'breaker:write',
  ];

  for (const permission of writes) {
    assert.equal(staffCan('support', permission), false, `support must not hold ${permission}`);
  }
  assert.ok(staffCan('support', 'merchant:read'));
  assert.ok(staffCan('support', 'audit:read'));
});

test('only a superadmin may change what the whole platform trusts', () => {
  // These two are the platform-wide levers: who else is staff, and which assets
  // every merchant may accept. An operator's mistakes stay inside one merchant.
  for (const permission of ['staff:write', 'asset_list:write'] as const) {
    assert.equal(staffCan('support', permission), false);
    assert.equal(staffCan('operator', permission), false);
    assert.equal(staffCan('superadmin', permission), true);
  }
});

test('every permission is held by at least one role', () => {
  // An unreachable permission is either a missing grant or dead code, and both are
  // worth hearing about at test time rather than when a route always 403s.
  for (const permission of STAFF_PERMISSIONS) {
    const holders = STAFF_ROLES.filter((role) => staffCan(role, permission));
    assert.ok(holders.length > 0, `no role holds ${permission}`);
  }
});

test('nobody may grant a role above their own', () => {
  for (const actor of STAFF_ROLES) {
    for (const granted of assignableStaffRoles(actor)) {
      assert.ok(
        STAFF_ROLE_RANK[granted] <= STAFF_ROLE_RANK[actor],
        `${actor} must not be able to grant ${granted}`,
      );
    }
  }
  assert.deepEqual(assignableStaffRoles('support'), ['support']);
  assert.deepEqual(assignableStaffRoles('superadmin'), [...STAFF_ROLES]);
});

test('authorize refuses a role that lacks the permission', () => {
  assert.throws(
    () => staffAuthorize({ role: 'support', mfaSatisfiedAt: Date.now() }, 'merchant:suspend'),
    StaffPermissionDeniedError,
  );
});

test('the role check runs before the elevation check', () => {
  /**
   * A support user attempting an elevation-gated action must be told their role is
   * insufficient, not asked to re-confirm an authenticator that would change
   * nothing. Beyond the poor experience, answering "confirm with your
   * authenticator" reveals that the action is gated to someone with no business
   * knowing it exists.
   */
  assert.throws(
    () => staffAuthorize({ role: 'support', mfaSatisfiedAt: null }, 'staff:write'),
    StaffPermissionDeniedError,
  );
});

test('an elevated action needs the second factor proven recently', () => {
  const now = Date.now();

  // Never proven.
  assert.throws(
    () => staffAuthorize({ role: 'superadmin', mfaSatisfiedAt: null, now }, 'staff:write'),
    StaffElevationRequiredError,
  );

  // Proven, but too long ago.
  assert.throws(
    () =>
      staffAuthorize(
        { role: 'superadmin', mfaSatisfiedAt: now - STAFF_ELEVATION_WINDOW_MS - 1, now },
        'staff:write',
      ),
    StaffElevationRequiredError,
  );

  // Just inside the window.
  staffAuthorize(
    { role: 'superadmin', mfaSatisfiedAt: now - STAFF_ELEVATION_WINDOW_MS + 1, now },
    'staff:write',
  );
});

test('a stale second factor does not block an unelevated read', () => {
  // Support staff answering a question all day should not be re-confirming to read.
  staffAuthorize({ role: 'support', mfaSatisfiedAt: 0, now: Date.now() }, 'merchant:read');
});

test('the staff elevation window is shorter than the merchant one', async () => {
  const { ELEVATION_WINDOW_MS } = await import('./rbac.js');
  assert.ok(
    STAFF_ELEVATION_WINDOW_MS < ELEVATION_WINDOW_MS,
    'staff act on other people’s money and should re-confirm more often',
  );
});

test('suspension is deliberately not elevation-gated', () => {
  /**
   * Not an oversight. Suspension is loud, immediately visible to the merchant, and
   * reversible in one click, so gating it would slow the response to an incident
   * without making anything safer. The actions that are gated are the quiet,
   * durable ones.
   */
  assert.equal(staffRequiresElevation('merchant:suspend'), false);
  assert.equal(staffRequiresElevation('contract:decide'), true);
  assert.equal(staffRequiresElevation('payment:reassign'), true);
  assert.equal(staffRequiresElevation('staff:write'), true);
  assert.equal(staffRequiresElevation('asset_list:write'), true);
});

test('reads of a named merchant are auditable; browsing a list is not', () => {
  assert.equal(isAuditableStaffRead('merchant:read', 'org-1'), true);
  assert.equal(isAuditableStaffRead('payment:read', 'inv-1'), true);
  // No target: a list page is not an access to any one merchant's data, and logging
  // it would bury the accesses that matter under rows nobody reads.
  assert.equal(isAuditableStaffRead('merchant:read', null), false);
  // Writes are recorded by the service that performs them, with their own action
  // name and metadata — recording them here too would double every entry.
  assert.equal(isAuditableStaffRead('merchant:suspend', 'org-1'), false);
});

test('role ranks are unique, so ordering is total', () => {
  const ranks = STAFF_ROLES.map((role: StaffRole) => STAFF_ROLE_RANK[role]);
  assert.equal(new Set(ranks).size, ranks.length);
});
