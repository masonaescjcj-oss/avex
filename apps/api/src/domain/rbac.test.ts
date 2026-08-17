import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ELEVATION_WINDOW_MS,
  ElevationRequiredError,
  PERMISSIONS,
  PermissionDeniedError,
  ROLES_ASCENDING,
  assignableRoles,
  authorize,
  can,
  delayFor,
  permissionsFor,
  requiresElevation,
} from './rbac.js';

test('only the owner may change where money is sent', () => {
  // The core security decision in this module. Everything an admin can do is
  // recoverable; redirecting revenue is not.
  assert.equal(can('owner', 'payout_address:write'), true);
  assert.equal(can('admin', 'payout_address:write'), false);
  assert.equal(can('developer', 'payout_address:write'), false);
  assert.equal(can('viewer', 'payout_address:write'), false);
});

test('roles nest, each containing every permission of the one below', () => {
  for (let i = 1; i < ROLES_ASCENDING.length; i++) {
    const lower = ROLES_ASCENDING[i - 1]!;
    const higher = ROLES_ASCENDING[i]!;
    const higherSet = new Set(permissionsFor(higher));

    for (const permission of permissionsFor(lower)) {
      assert.ok(
        higherSet.has(permission),
        `${higher} should inherit ${permission} from ${lower}`,
      );
    }
    assert.ok(
      permissionsFor(higher).length > permissionsFor(lower).length,
      `${higher} should have strictly more than ${lower}`,
    );
  }
});

test('viewer can read but cannot write anything', () => {
  for (const permission of PERMISSIONS) {
    if (permission.endsWith(':read')) continue;
    assert.equal(can('viewer', permission), false, `viewer should not have ${permission}`);
  }
  assert.equal(can('viewer', 'invoice:read'), true);
});

test('developer can issue keys and invoices but cannot touch members or assets', () => {
  assert.equal(can('developer', 'apikey:write'), true);
  assert.equal(can('developer', 'invoice:create'), true);
  assert.equal(can('developer', 'webhook:write'), true);

  assert.equal(can('developer', 'member:invite'), false);
  assert.equal(can('developer', 'asset:write'), false);
  assert.equal(can('developer', 'invoice:refund'), false);
});

test('authorize rejects a permission the role lacks', () => {
  assert.throws(
    () => authorize({ role: 'admin', mfaSatisfiedAt: Date.now() }, 'payout_address:write'),
    PermissionDeniedError,
  );
});

test('elevated permissions require a recent second factor', () => {
  const now = 1_700_000_000_000;

  // Never proven.
  assert.throws(
    () => authorize({ role: 'owner', mfaSatisfiedAt: null, now }, 'payout_address:write'),
    ElevationRequiredError,
  );

  // Proven too long ago.
  assert.throws(
    () =>
      authorize(
        { role: 'owner', mfaSatisfiedAt: now - ELEVATION_WINDOW_MS - 1, now },
        'payout_address:write',
      ),
    ElevationRequiredError,
  );

  // Proven within the window.
  assert.doesNotThrow(() =>
    authorize(
      { role: 'owner', mfaSatisfiedAt: now - ELEVATION_WINDOW_MS + 1000, now },
      'payout_address:write',
    ),
  );
});

test('ordinary permissions do not demand elevation', () => {
  assert.equal(requiresElevation('invoice:read'), false);
  assert.doesNotThrow(() =>
    authorize({ role: 'viewer', mfaSatisfiedAt: null }, 'invoice:read'),
  );
});

test('a payout address change is delayed, not immediate', () => {
  assert.equal(delayFor('payout_address:write'), 24 * 60 * 60 * 1000);
  assert.equal(delayFor('invoice:create'), null);
});

test('nobody may grant a role above their own', () => {
  assert.deepEqual(assignableRoles('viewer'), ['viewer']);
  assert.deepEqual(assignableRoles('developer'), ['viewer', 'developer']);
  assert.deepEqual(assignableRoles('admin'), ['viewer', 'developer', 'admin']);
  assert.deepEqual(assignableRoles('owner'), ['viewer', 'developer', 'admin', 'owner']);
});
