import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadEnv } from './env.js';
import { formatPreflight, preflight, type Level } from './preflight.js';

/**
 * The report an operator reads before taking real money.
 *
 * Every finding it produces is a gap that otherwise announces itself as silence, so the tests
 * here are mostly about the levels: what is `blocked` has to be something that stops the product
 * working, and what is `degraded` has to be a choice somebody might have made on purpose. Get
 * that wrong in either direction and the report is ignored — either because it always says
 * `blocked`, or because it said `ready` about a deployment that could not send an email.
 */

/** A deployment configured as far as configuration goes. */
const complete = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/avex',
  SMTP_URL: 'smtps://user:pass@mail.example.com',
  MAIL_FROM: 'no-reply@avexpay.net',
  OPERATOR_EMAIL: 'ops@avexpay.net',
  EVM_RPC_URLS: 'bsc=https://bsc.example.com,tron=https://tron.example.com/jsonrpc',
  FORWARDER_FACTORIES: 'bsc=0x00000000000000000000000000000000000f4c70',
  FORWARDER_IMPLEMENTATIONS: 'bsc=0x00000000000000000000000000000000000000e1',
  FEE_COLLECTORS: 'bsc=0x3333333333333333333333333333333333333333',
  SETTLEMENT_KEY_HEX: `0x${'11'.repeat(32)}`,
  CRON_SECRET: 'a-secret-long-enough-to-be-accepted',
  MEMO_SECRET: 'another-secret-long-enough-to-be-accepted',
};

const check = (overrides: Record<string, string | undefined> = {}) => {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...complete, ...overrides })) {
    if (value !== undefined) merged[key] = value;
  }
  return preflight(loadEnv(merged));
};

const areas = (result: ReturnType<typeof preflight>, level: Level) =>
  result.findings.filter((finding) => finding.level === level).map((finding) => finding.area);

describe('preflight', () => {
  test('a fully configured deployment is ready', () => {
    const result = check();
    assert.equal(result.verdict, 'ready', JSON.stringify(result.findings, null, 2));
  });

  test('no mail server is blocking, because it looks like it is working', () => {
    /**
     * The most misleading state this product has. Every message is composed and logged, so the
     * signup flow completes, the notice about a payout address change is written, and nothing
     * fails — while no merchant can confirm an address and the twenty-four-hour delay protects
     * nobody.
     */
    const result = check({ SMTP_URL: undefined });
    assert.equal(result.verdict, 'blocked');
    assert.ok(areas(result, 'blocked').includes('mail'));
    assert.match(
      result.findings.find((finding) => finding.area === 'mail')!.detail,
      /looks like it is working/,
    );
  });

  test('no operator address is degraded, not blocked', () => {
    // A choice: alerts still reach the log. Blocking on it would make the report cry wolf.
    const result = check({ OPERATOR_EMAIL: undefined });
    assert.equal(result.verdict, 'degraded');
    assert.deepEqual(areas(result, 'blocked'), []);
    assert.ok(areas(result, 'degraded').includes('alerts'));
  });

  test('a settling chain with no key is blocking', () => {
    /**
     * The failure that costs the most and shows the least: a payment on BNB Chain is detected,
     * credited, announced to the merchant by webhook, and left at its deposit address.
     */
    const result = check({ SETTLEMENT_KEY_HEX: undefined });
    assert.equal(result.verdict, 'blocked');
    const finding = result.findings.find((entry) => entry.area === 'settlement')!;
    assert.match(finding.detail, /bsc/);
    assert.match(finding.detail, /left at their\s+deposit addresses/);
  });

  test('a TRON-only deployment needs no settlement key at all', () => {
    /**
     * The shortest path to taking real money, and the report has to agree with that rather than
     * demanding a key for a chain that sends no transactions.
     */
    const result = check({
      EVM_RPC_URLS: 'tron=https://tron.example.com/jsonrpc',
      SETTLEMENT_KEY_HEX: undefined,
      FORWARDER_FACTORIES: undefined,
      FORWARDER_IMPLEMENTATIONS: undefined,
      FEE_COLLECTORS: undefined,
    });

    assert.deepEqual(areas(result, 'blocked'), [], JSON.stringify(result.findings, null, 2));
    assert.ok(
      result.findings.some((finding) => finding.area === 'chains.tron' && finding.level === 'ready'),
      'and TRON is reported as ready rather than left out',
    );
  });

  test('half a forwarder deployment is reported as such', () => {
    /**
     * A factory with no logic address derives addresses from an empty string — valid hex, a real
     * address, and one nothing can ever settle. `compose` drops the chain rather than deriving
     * them, so the visible effect is a chain that quietly cannot invoice.
     */
    const result = check({ FORWARDER_IMPLEMENTATIONS: undefined });
    assert.ok(areas(result, 'degraded').includes('chains.bsc'));
    assert.match(
      result.findings.find((finding) => finding.area === 'chains.bsc')!.detail,
      /no FORWARDER_IMPLEMENTATIONS entry/,
    );
  });

  test('a production deployment with a key in the environment is blocked', () => {
    // The key provider refuses it at startup; saying so here means it is not discovered then.
    const result = check({ NODE_ENV: 'production' });
    assert.equal(result.verdict, 'blocked');
    assert.match(
      result.findings.find((finding) => finding.detail.includes('NODE_ENV=production'))!.detail,
      /KMS-backed/,
    );
  });

  test('nothing driving the jobs is blocking', () => {
    /**
     * Both delays this product uses for security — the payout address and the deposit wallet —
     * are applied by a job. Without a driver they never elapse, so a merchant who scheduled a
     * change waits forever and a failed webhook is never retried.
     */
    const result = check({ CRON_SECRET: undefined, RUN_JOBS_IN_PROCESS: 'false' });
    assert.equal(result.verdict, 'blocked');
    assert.ok(areas(result, 'blocked').includes('jobs'));

    // With in-process timers it is fine, which is the default and the single-host case.
    assert.ok(!areas(check({ CRON_SECRET: undefined }), 'blocked').includes('jobs'));
  });

  test('a chain with no collector earns nothing, and that is a choice', () => {
    const result = check({ FEE_COLLECTORS: undefined });
    assert.equal(result.verdict, 'degraded');
    assert.ok(areas(result, 'degraded').includes('commission.bsc'));
  });

  test('the report puts what is blocking first', () => {
    // It is read top-down, under pressure, by somebody who wants the next action.
    const text = formatPreflight(check({ SMTP_URL: undefined, OPERATOR_EMAIL: undefined }));
    assert.ok(text.indexOf('BLOCKED') < text.indexOf('degraded'));
    assert.match(text, /verdict: blocked/);
  });
});
