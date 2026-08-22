import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Alert } from '@avex/core';

import { ConsoleMailer } from '../mailer.js';
import type { Mailer } from '../mailer.js';
import { AlertForwarder, DEFAULT_ALERT_COOLDOWN_MS } from './alerts.js';

/**
 * Alerting, and the two ways it fails to be alerting.
 *
 * It sends nothing, or it sends so much that somebody filters the folder. The second is the one
 * that happens: every condition the settlement runner raises persists — an empty gas wallet is
 * still empty on the next pass thirty seconds later — so a forwarder without a cooldown sends
 * two messages a minute until the person receiving them stops reading, and then the next alert
 * is missed. That is what most of this file is about.
 */

const critical = (kind: Alert['kind'], detail = 'something is wrong'): Alert => ({
  severity: 'critical',
  kind,
  detail,
});

const warning = (kind: Alert['kind'], detail = 'a number is moving'): Alert => ({
  severity: 'warning',
  kind,
  detail,
});

/** A mailer that records, and one that refuses. */
const recorder = () => new ConsoleMailer('https://avexpay.net', () => {});

describe('forwarding settlement alerts', () => {
  test('a critical alert is emailed, with the figures in it', async () => {
    const mailer = recorder();
    const forwarder = new AlertForwarder(mailer, 'ops@avexpay.net');

    await forwarder.forward([
      critical('low_gas_balance', 'bsc gas wallet 0x99 has 100 wei, needs 4750000000000'),
    ]);

    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0]!.to, 'ops@avexpay.net');
    assert.match(mailer.sent[0]!.subject, /\[critical\]/);
    assert.match(mailer.sent[0]!.subject, /low gas balance/, 'readable in a notification');
    assert.match(mailer.sent[0]!.body, /needs 4750000000000/, 'the detail carries the numbers');
  });

  test('a warning is logged and not emailed', async () => {
    /**
     * A warning is a number moving in the wrong direction — the spend cap reached, fifty
     * settlements of runway left. It belongs in a log and a dashboard. Emailing both severities
     * is how a critical alert ends up in the same filtered folder as everything else.
     */
    const mailer = recorder();
    const lines: string[] = [];
    const forwarder = new AlertForwarder(mailer, 'ops@avexpay.net', (message) =>
      lines.push(message),
    );

    await forwarder.forward([warning('spend_cap'), warning('low_gas_balance')]);

    assert.equal(mailer.sent.length, 0);
    assert.equal(lines.length, 2, 'both are still recorded');
  });

  test('the same condition is emailed once per window, not once per pass', async () => {
    /**
     * The property this class exists for. A stuck transaction is stuck until somebody replaces
     * it, and settlement passes every thirty seconds — so this is the difference between one
     * message and a hundred and twenty an hour.
     */
    const mailer = recorder();
    const forwarder = new AlertForwarder(mailer, 'ops@avexpay.net', () => {});

    await forwarder.forward([critical('stuck_transaction', 'stuck for 300s')], 0);
    await forwarder.forward([critical('stuck_transaction', 'stuck for 330s')], 30_000);
    await forwarder.forward([critical('stuck_transaction', 'stuck for 360s')], 60_000);

    assert.equal(mailer.sent.length, 1, 'one message for one condition');

    // And again once the window has passed, because a fix that never came should be re-raised.
    await forwarder.forward(
      [critical('stuck_transaction', 'stuck for 1200s')],
      DEFAULT_ALERT_COOLDOWN_MS + 1,
    );
    assert.equal(mailer.sent.length, 2);
  });

  test('the throttle keys on the kind, not on the wording', async () => {
    /**
     * The way the throttle would silently not work. Every stuck-transaction alert says how long
     * it has been stuck, so the detail is different every pass — a key that included it would be
     * a new key each time, and the cooldown would never match anything.
     */
    const mailer = recorder();
    const forwarder = new AlertForwarder(mailer, 'ops@avexpay.net', () => {});

    for (let pass = 0; pass < 10; pass += 1) {
      await forwarder.forward(
        [critical('stuck_transaction', `stuck for ${300 + pass * 30}s`)],
        pass * 30_000,
      );
    }

    assert.equal(mailer.sent.length, 1);
  });

  test('two different conditions are two messages', async () => {
    // The throttle is per kind, so a gas wallet emptying while a transaction is stuck is two
    // things somebody needs to know rather than one.
    const mailer = recorder();
    const forwarder = new AlertForwarder(mailer, 'ops@avexpay.net', () => {});

    await forwarder.forward([critical('low_gas_balance'), critical('reverted_settlement')], 0);
    assert.equal(mailer.sent.length, 2);
  });

  test('with no address configured, nothing is emailed and everything is logged', async () => {
    const mailer = recorder();
    const lines: string[] = [];
    const forwarder = new AlertForwarder(mailer, undefined, (message) => lines.push(message));

    await forwarder.forward([critical('low_gas_balance'), warning('spend_cap')]);

    assert.equal(mailer.sent.length, 0);
    assert.equal(lines.length, 2);
  });

  test('a mail failure does not throw, and does not consume the cooldown', async () => {
    /**
     * This runs inside a settlement pass. A mail server having a bad minute must not fail the
     * pass — the alert would then be about the alerting rather than about the money — and it must
     * not count as delivered either, or the one message about an empty gas wallet is the one that
     * was lost.
     */
    let failing = true;
    const lines: string[] = [];
    const mailer = recorder();
    const flaky: Mailer = {
      ...mailer,
      async sendOperatorAlert(to: string, alert: { severity: string; kind: string; detail: string }) {
        if (failing) throw new Error('smtp is down');
        await mailer.sendOperatorAlert(to, alert);
      },
    } as unknown as Mailer;
    const forwarder = new AlertForwarder(flaky, 'ops@avexpay.net', (message) =>
      lines.push(message),
    );

    await assert.doesNotReject(forwarder.forward([critical('low_gas_balance')], 0));
    assert.equal(mailer.sent.length, 0);
    assert.ok(lines.some((line) => /could not be emailed/.test(line)));

    // The next pass, seconds later, tries again rather than waiting out a cooldown it never
    // earned.
    failing = false;
    await forwarder.forward([critical('low_gas_balance')], 1_000);
    assert.equal(mailer.sent.length, 1);
  });
});
