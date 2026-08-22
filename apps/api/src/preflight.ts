import { SUPPORTED_CHAINS, chainConfig } from '@avex/core';
import type { ChainId } from '@avex/core';

import type { Env } from './env.js';

/**
 * What this deployment can and cannot do, from its configuration alone.
 *
 * Every gap this reports is one that otherwise announces itself as silence. No SMTP server and a
 * merchant cannot confirm their address. No settlement key and payments are detected, credited,
 * and never moved. A factory without its logic address and every deposit address is one nothing
 * can settle. None of those produce an error at startup, because none of them are errors — they
 * are a deployment that is partly configured, which is the normal state of one that is being
 * brought up.
 *
 * So this is the thing to run before taking real money, and the thing to paste into a message
 * when asking why something is not happening. It reads configuration only: no database, no
 * network, no keys used. That is deliberate — a preflight that could itself fail for a reason
 * unrelated to what it is checking is a preflight nobody trusts.
 */

export type Level = 'ready' | 'degraded' | 'blocked';

export interface Finding {
  readonly level: Level;
  readonly area: string;
  readonly detail: string;
}

export interface Preflight {
  readonly findings: readonly Finding[];
  /** The worst level present, which is what a caller exits on. */
  readonly verdict: Level;
}

export function preflight(env: Env): Preflight {
  const findings: Finding[] = [];
  const add = (level: Level, area: string, detail: string) => findings.push({ level, area, detail });

  // ── the things without which nothing works ────────────────────────────────

  if (env.SMTP_URL === undefined) {
    add(
      'blocked',
      'mail',
      'SMTP_URL is not set. Nothing is emailed: a merchant cannot confirm their address, and the ' +
        'twenty-four-hour notice before a payout address changes reaches a log file instead of a ' +
        'person. Every message is composed and logged, so this looks like it is working.',
    );
  } else if (env.MAIL_FROM.endsWith('@example.com') || env.MAIL_FROM.endsWith('@example.test')) {
    add('blocked', 'mail', `MAIL_FROM is ${env.MAIL_FROM}, which no provider will send as.`);
  }

  if (env.OPERATOR_EMAIL === undefined) {
    add(
      'degraded',
      'alerts',
      'OPERATOR_EMAIL is not set. A gas wallet that cannot cover a settlement, a stuck nonce, a ' +
        'stalled watcher and a reverted settlement are logged and not sent. None of those ' +
        'produce a merchant complaint: from their side the payment arrived.',
    );
  }

  // ── chains ────────────────────────────────────────────────────────────────

  const withRpc = SUPPORTED_CHAINS.filter((chain) => (env.EVM_RPC_URLS[chain]?.length ?? 0) > 0);
  if (withRpc.length === 0) {
    add(
      'blocked',
      'chains',
      'EVM_RPC_URLS names no chain, so nothing is watched and no payment can be detected. TRON ' +
        'belongs here too: it serves an Ethereum-compatible JSON-RPC.',
    );
  }

  for (const chain of SUPPORTED_CHAINS) {
    const hasRpc = (env.EVM_RPC_URLS[chain]?.length ?? 0) > 0;
    if (!hasRpc) continue;

    const config = chainConfig(chain);

    if (config.addressModel === 'unique') {
      const factory = env.FORWARDER_FACTORIES[chain];
      const implementation = env.FORWARDER_IMPLEMENTATIONS[chain];

      if (!factory || !implementation) {
        /**
         * Both halves or neither, and the asymmetry is worth naming.
         *
         * A factory with no logic address derives addresses from an empty string: valid hex, a
         * real address, and one nothing can ever settle. Payers would fund them and the money
         * would be unreachable. `compose` drops such a chain rather than deriving, so the effect
         * is that the chain quietly cannot issue invoices.
         */
        add(
          'degraded',
          `chains.${chain}`,
          `has an RPC endpoint but ${!factory ? 'no FORWARDER_FACTORIES entry' : ''}` +
            `${!factory && !implementation ? ' and ' : ''}` +
            `${!implementation ? 'no FORWARDER_IMPLEMENTATIONS entry' : ''}. ` +
            'It will be watched and cannot issue invoices. Run contracts/deploy.mjs.',
        );
      }
    }

    if (config.addressModel === 'shared-memo' && !env.SHARED_DEPOSIT_WALLETS[chain]) {
      add(
        'degraded',
        `chains.${chain}`,
        'has an RPC endpoint and no SHARED_DEPOSIT_WALLETS entry, so it cannot issue invoices.',
      );
    }

    if (config.addressModel === 'pooled') {
      /**
       * A pooled chain needs no configuration from us, and that is the point.
       *
       * Its deposit addresses are the merchant's own wallets, registered in the dashboard — so
       * whether it works is per merchant rather than per deployment, and this cannot see it
       * without a database. Said anyway, because "TRON is configured" is a sentence somebody
       * will otherwise read into the absence of a finding.
       */
      add(
        'ready',
        `chains.${chain}`,
        'is watched and needs nothing here: its deposit addresses are the wallets each merchant ' +
          'registers, so check the dashboard rather than this list.',
      );
    }
  }

  // ── money out ─────────────────────────────────────────────────────────────

  const settling = withRpc.filter((chain) => chainConfig(chain).settlement.kind !== 'direct');

  if (settling.length > 0 && !env.SETTLEMENT_KEY_HEX) {
    add(
      'blocked',
      'settlement',
      `SETTLEMENT_KEY_HEX is not set, and moving funds on ${settling.join(', ')} needs a ` +
        'transaction we sign. ' +
        'Payments there will be detected, credited, announced by webhook, and left at their ' +
        'deposit addresses. Chains that settle directly — TRON, TON — are unaffected.',
    );
  }

  if (env.SETTLEMENT_KEY_HEX && env.NODE_ENV === 'production') {
    /**
     * A refusal repeated here so it is not first met at startup.
     *
     * `LocalKeyProvider` throws in production, on purpose: the key pays for every settlement, so
     * a copy of it is a wallet somebody else can drain. What is needed is a KMS-backed provider,
     * and that is a decision rather than a variable.
     */
    add(
      'blocked',
      'settlement',
      'SETTLEMENT_KEY_HEX is set with NODE_ENV=production. The key provider refuses to hold a ' +
        'settlement key in process memory there — use a KMS-backed KeyProvider.',
    );
  }

  for (const chain of settling) {
    if (!env.FEE_COLLECTORS[chain]) {
      add(
        'degraded',
        `commission.${chain}`,
        'has no FEE_COLLECTORS entry, so invoices there carry no commission at all. Not an ' +
          'error — a chain we cannot form an address for must not have a fee sent to it — but ' +
          'it means the business earns nothing on that chain.',
      );
    }
  }

  // ── the scheduler ─────────────────────────────────────────────────────────

  if (!env.RUN_JOBS_IN_PROCESS && env.CRON_SECRET === undefined) {
    add(
      'blocked',
      'jobs',
      'nothing drives the background jobs: RUN_JOBS_IN_PROCESS is off and CRON_SECRET is unset, ' +
        'so /internal/jobs answers 404. Webhooks are never retried and the twenty-four-hour ' +
        'delays on payout and deposit-wallet changes never elapse.',
    );
  }

  if (findings.length === 0) {
    add('ready', 'configuration', 'nothing missing that can be checked from configuration alone.');
  }

  const verdict: Level = findings.some((finding) => finding.level === 'blocked')
    ? 'blocked'
    : findings.some((finding) => finding.level === 'degraded')
      ? 'degraded'
      : 'ready';

  return { findings, verdict };
}

/** The report as an operator reads it, worst first. */
export function formatPreflight(result: Preflight): string {
  const order: Record<Level, number> = { blocked: 0, degraded: 1, ready: 2 };
  const label: Record<Level, string> = {
    blocked: 'BLOCKED ',
    degraded: 'degraded',
    ready: 'ready   ',
  };

  const lines = [...result.findings]
    .sort((left, right) => order[left.level] - order[right.level])
    .map((finding) => `${label[finding.level]}  ${finding.area}\n            ${finding.detail}`);

  return `${lines.join('\n\n')}\n\nverdict: ${result.verdict}\n`;
}

/**
 * `npm run preflight --workspace @avex/api`
 *
 * Exits 1 when anything is blocked, so a deployment pipeline can gate on it. A degraded finding
 * exits 0: those are choices — a chain without a fee collector, alerts that only log — and a
 * pipeline that refused them would stop a deployment that is deliberately partial.
 */
if (process.argv[1]?.endsWith('preflight.js')) {
  const { loadEnv } = await import('./env.js');
  const result = preflight(loadEnv());
  process.stdout.write(formatPreflight(result));
  process.exit(result.verdict === 'blocked' ? 1 : 0);
}
