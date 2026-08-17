import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLES } from '../domain/rbac.js';
import { STAFF_ROLES } from '../domain/staff-rbac.js';
import { ROLE_VALUES, STAFF_ROLE_VALUES } from './schema.js';

/**
 * The schema duplicates the role list because the migration tool cannot import
 * application code. This test is what makes that duplication safe: adding a role
 * to the domain without adding it to the enum would otherwise fail at runtime, on
 * the first insert, in production.
 */
test('the database role enum matches the domain role list exactly', () => {
  assert.deepEqual(
    [...ROLE_VALUES],
    [...ROLES],
    'apps/api/src/db/schema.ts ROLE_VALUES has drifted from domain/rbac.ts ROLES — ' +
      'update both and generate a migration',
  );
});

test('the database staff role enum matches the domain staff role list exactly', () => {
  assert.deepEqual(
    [...STAFF_ROLE_VALUES],
    [...STAFF_ROLES],
    'apps/api/src/db/schema.ts STAFF_ROLE_VALUES has drifted from ' +
      'domain/staff-rbac.ts STAFF_ROLES — update both and generate a migration',
  );
});
