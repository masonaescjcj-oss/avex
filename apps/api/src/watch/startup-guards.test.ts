import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The two reasons the watcher refuses to start, guarded at the source.
 *
 * A guard on the text rather than on the behaviour, for the same reason as `gas-price-wiring`:
 * both branches live inside a `main()` that builds a database pool, a price service, a signer per
 * chain and an adapter per chain before reaching them. A test that exercised them would be a test
 * of that whole graph, and the thing worth protecting is one line and where it sits.
 *
 * What both guards protect is the same property, and it is the property this process is worst at
 * having: a watcher that is polling nothing is indistinguishable from a watcher that is finding
 * nothing, and the deployment around it goes on believing payments are being detected. There is
 * no error, no alert and no metric — a payer's transfer confirms, the merchant sees nothing, and
 * each blames the other. So "nothing to do" has to be fatal at startup, which is the only moment
 * anybody is looking.
 */

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'watcher.ts'),
  'utf8',
);

describe('the watcher refuses to run with nothing to watch', () => {
  test('no watchable chain is fatal', () => {
    assert.match(source, /if \(chains\.length === 0\) \{/);
    assert.match(source, /no chain is watchable/);
  });

  test('no listed approved asset on any chain is fatal', () => {
    /**
     * The case the first check cannot see. A configured chain whose catalogue is empty is
     * skipped one chain at a time, so with a single chain configured the loop completes, zero
     * adapters exist, and the process settles into polling nothing.
     *
     * It happens for an ordinary reason rather than a misconfiguration: the curated assets are
     * seeded by the API at startup, so a watcher started first on a fresh database has an
     * approved, listed nothing to look for.
     */
    assert.match(source, /if \(adapters\.size === 0\) \{/);
    assert.match(source, /no chain has a listed approved asset/);
  });

  test('the refusal comes before settlement starts', () => {
    /**
     * Ordering is the whole point of the second guard's placement.
     *
     * `startSettlement` builds a signer per chain and takes a nonce. Refusing after it has run
     * would mean a process that acquired signing state, exited, and left the next start to
     * reconcile it — for a condition known before any of that was needed.
     */
    const guard = source.indexOf('if (adapters.size === 0) {');
    const settlement = source.indexOf('await startSettlement(');

    assert.ok(guard > 0, 'the empty-catalogue guard is missing');
    assert.ok(settlement > 0, 'startSettlement is no longer called from the watcher');
    assert.ok(
      guard < settlement,
      'the empty-catalogue guard must run before settlement acquires a nonce',
    );
  });
});
