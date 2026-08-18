import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ELEVATION_ASK_AFTER_MS,
  NAV,
  can,
  defaultSection,
  elevationIsFresh,
  needsElevation,
  visibleNav,
} from './permissions.js';

/** The three roles' permission sets, as `/admin/me` returns them. */
const SUPPORT = [
  'merchant:read',
  'contract:read',
  'settlement:read',
  'payment:read',
  'health:read',
  'audit:read',
  'staff:read',
];
const OPERATOR = [
  ...SUPPORT,
  'merchant:suspend',
  'contract:decide',
  'payment:reassign',
  'webhook:replay',
  'breaker:write',
];
const SUPERADMIN = [...OPERATOR, 'staff:write', 'asset_list:write'];

test('a support user sees every read-only section', () => {
  const ids = visibleNav(SUPPORT).map((item) => item.id);
  assert.deepEqual(ids, ['health', 'merchants', 'revenue', 'unmatched', 'review', 'settlements', 'audit']);
});

test('a permission list missing a read hides that section', () => {
  const narrow = visibleNav(['merchant:read']).map((item) => item.id);
  // Revenue rides on `merchant:read`: every account's rate and volume is the same class
  // of data as the merchant list, so it is visible to exactly the same people.
  assert.deepEqual(narrow, ['merchants', 'revenue']);
});

test('an empty permission list shows no sections and no default', () => {
  assert.deepEqual(visibleNav([]), []);
  // Null rather than a guess: landing somewhere unreachable reads as a broken panel.
  assert.equal(defaultSection([]), null);
});

test('the default section is one the user can actually open', () => {
  for (const permissions of [SUPPORT, OPERATOR, SUPERADMIN, ['audit:read']]) {
    const section = defaultSection(permissions);
    assert.ok(section, 'a user with any read should land somewhere');
    assert.ok(
      visibleNav(permissions).some((item) => item.id === section),
      `${section} is not visible to this user`,
    );
  }
});

test('health is the landing section when available', () => {
  // The only screen that answers "is anything wrong right now".
  assert.equal(defaultSection(SUPPORT), 'health');
});

test('every nav item names a permission that some role holds', () => {
  // An item gated on a permission nobody has is an item nobody can ever reach.
  for (const item of NAV) {
    if (item.requires === undefined) continue;
    assert.ok(
      SUPERADMIN.includes(item.requires),
      `${item.id} requires ${item.requires}, which no role holds`,
    );
  }
});

test('nav ids are unique, so a section cannot be ambiguous', () => {
  const ids = NAV.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('can reflects the list rather than guessing from a role', () => {
  assert.equal(can(SUPPORT, 'merchant:suspend'), false);
  assert.equal(can(OPERATOR, 'merchant:suspend'), true);
  assert.equal(can(OPERATOR, 'staff:write'), false);
  assert.equal(can(SUPERADMIN, 'staff:write'), true);
});

test('the elevated set matches the server list', () => {
  /**
   * Duplicated from the server so the panel can ask for a code before submitting,
   * rather than losing a long review note to a 403. If it drifts, the request is
   * refused — the safe direction for the copy to be stale in.
   */
  for (const permission of ['staff:write', 'asset_list:write', 'contract:decide', 'payment:reassign']) {
    assert.equal(needsElevation(permission), true, permission);
  }
  // Suspension is loud and reversible in one click, so it is deliberately not gated.
  assert.equal(needsElevation('merchant:suspend'), false);
  assert.equal(needsElevation('merchant:read'), false);
});

test('a missing or unparseable mfa stamp counts as stale', () => {
  // Assuming freshness would submit the action and lose the operator's input.
  assert.equal(elevationIsFresh(null), false);
  assert.equal(elevationIsFresh(undefined), false);
  assert.equal(elevationIsFresh('not a date'), false);
  assert.equal(elevationIsFresh(''), false);
});

test('freshness expires before the server window does', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const recent = new Date(now - 10_000).toISOString();
  const old = new Date(now - ELEVATION_ASK_AFTER_MS - 1).toISOString();

  assert.equal(elevationIsFresh(recent, now), true);
  assert.equal(elevationIsFresh(old, now), false);
  // The server allows two minutes; asking again at ninety seconds avoids submitting
  // into a window that closes between the check and the request arriving.
  assert.ok(ELEVATION_ASK_AFTER_MS < 2 * 60 * 1000);
});
