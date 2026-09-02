import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * That the real service graph wires signup to a fee plan.
 *
 * A guard on the source, for the reason the integration test cannot cover it: every HTTP test in
 * this suite builds its own graph by hand, so `compose.ts` can pass a no-op and all seventy-two
 * of them still pass. That is not a hypothetical — it is exactly how the bug this protects
 * against survived. `ensureForOrganization` was called from thirty-four places, all tests, and
 * every merchant who ever signed up had no fee plan, no rate, no deposit address, and no way to
 * take a payment on any chain. The behaviour test proves the behaviour; only this proves the
 * wiring.
 *
 * The source rather than `dist`: tests run from the build, and the compiled output is not what a
 * reviewer edits — a guard that read it would pass on a file nobody looks at.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'compose.ts'), 'utf8');

describe('the composed graph', () => {
  test('signup creates a fee plan for the new organization', () => {
    /**
     * `AuthService` requires the hook, so the compiler guarantees *something* is passed. What it
     * cannot guarantee is that the something does the work — an `async () => {}` satisfies the
     * type perfectly and reproduces the original bug exactly.
     */
    assert.match(
      source,
      /new AuthService\([\s\S]*?ensureForOrganization\([\s\S]*?\)/,
      'compose.ts must pass a hook that calls ensureForOrganization; a no-op type-checks and ' +
        'leaves every merchant unable to be paid',
    );
  });

  test('the hook runs inside the signup transaction', () => {
    /**
     * The `tx` argument is what makes an organisation and its plan atomic. Passing the pool
     * instead would commit the organisation first, so a failure between the two would leave the
     * broken state permanently — and it is a one-word difference that nothing else would catch.
     */
    assert.match(
      source,
      /ensureForOrganization\(\s*organizationId\s*,\s*new Date\(\)\s*,\s*tx\s*\)/,
      'the fee plan must be created with the signup transaction, not the connection pool',
    );
  });
});
