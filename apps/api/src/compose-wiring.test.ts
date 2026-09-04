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
const settlement = readFileSync(join(here, '..', 'src', 'settle', 'start.ts'), 'utf8');

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

  test('the deployment\'s fee policy reaches both services that read it', () => {
    /**
     * `ChainMinimums` and `FeePlanService` both take a policy and both fall back to the
     * compiled defaults when given none — which is right for a class that has to be testable
     * on its own, and silent when it is the real graph that forgot. The failure it produces:
     * a deployment lowers its minimum invoice, the order is accepted at the new floor and
     * priced by the old rule, and neither number appears anywhere near the other.
     *
     * So the wiring is asserted here. There is no behaviour test that could: every HTTP suite
     * builds its own graph, and the defaults are correct in all of them.
     */
    assert.match(
      source,
      /const policy = feePolicy\(env\)/,
      'compose.ts must build one policy from the environment',
    );
    assert.match(
      source,
      /new ChainMinimums\(gas, policy\)/,
      'the minimum-invoice check must use the configured policy, not the compiled default',
    );
    assert.match(
      source,
      /new FeePlanService\([\s\S]*?feePolicy: policy[\s\S]*?\)/,
      'the commission service must use the same policy the minimum check does',
    );
  });

  test('the settlement runner reads the same configuration', () => {
    /**
     * It decides whether a settlement is worth its gas, from the same numbers that decided
     * the invoice was worth taking. A runner on the compiled defaults would defer settlements
     * a deployment had configured itself to make — in a process the API cannot see.
     */
    assert.match(
      settlement,
      /policyFromEnv\(env\)/,
      "settle/start.ts must build its policy from the environment",
    );
    assert.doesNotMatch(
      settlement,
      /new FeePolicy\(DEFAULT_FEE_POLICY\)/,
      'the settlement runner must not compile in its own policy',
    );
  });
});
