import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toHex } from '../crypto/keccak256.js';
import {
  CONTROL_SELECTORS,
  PROXY_SLOTS,
  SELECTORS,
  encodeUint256,
} from './abi.js';
import { ContractProbe, type EvmCaller } from './probe.js';
import { assessRisk, isAutoApprovable, toleranceForFeeOnTransfer } from './risk.js';
import type { Finding } from './types.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const HOLDER = '0x2222222222222222222222222222222222222222';
const PROBE_BYTECODE = '0x6080604052';

const EMPTY_SLOT = `0x${'00'.repeat(32)}`;

function word(value: bigint): string {
  return toHex(encodeUint256(value));
}

function abiString(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = toHex(bytes).slice(2).padEnd(64, '0');
  return `0x${word(32n).slice(2)}${word(BigInt(bytes.length)).slice(2)}${padded}`;
}

/** A token whose every response the test dictates. */
interface FakeTokenSpec {
  code?: string;
  symbol?: string;
  decimals?: number | 'revert';
  totalSupply?: bigint;
  balanceOfWorks?: boolean;
  slots?: Record<string, string>;
  /** Amount actually delivered by a simulated transfer of 1 whole token. */
  delivers?: (amount: bigint) => bigint;
  supportsOverrides?: boolean;
  storageReadable?: boolean;
}

function fakeCaller(spec: FakeTokenSpec): EvmCaller {
  const caller: EvmCaller = {
    async getCode() {
      return spec.code ?? '0x60806040523480156100';
    },
    async call(_to, data) {
      const sel = data.slice(0, 10);
      if (sel === SELECTORS.symbol) return abiString(spec.symbol ?? 'TKN');
      if (sel === SELECTORS.name) return abiString('Token');
      if (sel === SELECTORS.decimals) {
        if (spec.decimals === 'revert') throw new Error('execution reverted');
        return word(BigInt(spec.decimals ?? 18));
      }
      if (sel === SELECTORS.totalSupply) return word(spec.totalSupply ?? 10n ** 24n);
      if (sel === SELECTORS.balanceOf) {
        if (spec.balanceOfWorks === false) throw new Error('execution reverted');
        return word(10n ** 20n);
      }
      throw new Error(`unexpected call ${sel}`);
    },
    async getStorageAt(_address, slot) {
      if (spec.storageReadable === false) throw new Error('not supported');
      return spec.slots?.[slot] ?? EMPTY_SLOT;
    },
  };

  if (spec.supportsOverrides !== false) {
    return {
      ...caller,
      async callWithCodeOverride(_to, data) {
        // The probe encodes (token, recipient, amount); amount is the third word.
        const amount = BigInt(`0x${data.slice(10 + 128, 10 + 192)}`);
        return word((spec.delivers ?? ((value: bigint) => value))(amount));
      },
    };
  }
  return caller;
}

const BASE = {
  chain: 'bsc' as const,
  contract: TOKEN,
  holder: HOLDER,
  transferProbeBytecode: PROBE_BYTECODE,
  pricedSymbols: ['USDT', 'USDC', 'ETH', 'BNB'],
};

function findingFor(findings: readonly Finding[], kind: string): Finding | undefined {
  return findings.find((finding) => finding.kind === kind);
}

test('an address with no code is blocked', async () => {
  const probe = new ContractProbe(fakeCaller({ code: '0x' }));
  const report = await probe.probe(BASE);

  assert.equal(report.verdict, 'blocked');
  assert.equal(findingFor(report.findings, 'no_code')?.status, 'present');
});

test('a contract that does not answer decimals is blocked', async () => {
  const probe = new ContractProbe(fakeCaller({ decimals: 'revert' }));
  const report = await probe.probe(BASE);

  assert.equal(report.verdict, 'blocked');
  assert.equal(findingFor(report.findings, 'not_erc20')?.status, 'present');
});

test('a contract without balanceOf is blocked', async () => {
  // The settlement path cannot function without it.
  const probe = new ContractProbe(fakeCaller({ balanceOfWorks: false }));
  const report = await probe.probe(BASE);
  assert.equal(report.verdict, 'blocked');
});

test('zero total supply is blocked', async () => {
  const probe = new ContractProbe(fakeCaller({ totalSupply: 0n }));
  const report = await probe.probe(BASE);

  assert.equal(report.verdict, 'blocked');
  assert.equal(findingFor(report.findings, 'zero_supply')?.status, 'present');
});

test('absurd decimals are blocked rather than sent to review', async () => {
  // No reviewer can make 255 decimals work with the amount arithmetic.
  const probe = new ContractProbe(fakeCaller({ decimals: 200 }));
  const report = await probe.probe(BASE);

  assert.equal(report.verdict, 'blocked');
  assert.equal(findingFor(report.findings, 'decimals_unusual')?.severity, 'blocking');
});

test('a well-behaved unknown token still needs a human', async () => {
  // Clean checks never add up to approval. A merchant-submitted contract lands in
  // review at best, because the cost of being wrong is other people's money.
  const probe = new ContractProbe(fakeCaller({ symbol: 'MERCH' }));
  const report = await probe.probe(BASE);

  assert.equal(report.verdict, 'review');
  assert.equal(findingFor(report.findings, 'fee_on_transfer')?.status, 'absent');
  assert.equal(findingFor(report.findings, 'issuer_controls')?.status, 'absent');
});

test('a token claiming a major symbol is flagged as impersonation', async () => {
  // The attack the module exists for.
  const probe = new ContractProbe(fakeCaller({ symbol: 'USDT' }));
  const report = await probe.probe(BASE);

  const finding = findingFor(report.findings, 'symbol_impersonation');
  assert.equal(finding?.status, 'present');
  assert.equal(finding?.severity, 'high');
  assert.equal(report.verdict, 'review');
});

test('a populated proxy slot is detected', async () => {
  const probe = new ContractProbe(
    fakeCaller({
      slots: {
        [PROXY_SLOTS.implementation]:
          '0x0000000000000000000000003333333333333333333333333333333333333333',
      },
    }),
  );
  const report = await probe.probe(BASE);

  const finding = findingFor(report.findings, 'upgradeable_proxy');
  assert.equal(finding?.status, 'present');
  assert.equal(finding?.severity, 'high');
  assert.match(finding!.detail, /replaced tomorrow/);
});

test('DELEGATECALL without a standard slot is still flagged', async () => {
  const probe = new ContractProbe(fakeCaller({ code: '0x6080604052f4600052' }));
  const report = await probe.probe(BASE);

  assert.equal(findingFor(report.findings, 'upgradeable_proxy')?.status, 'present');
});

test('unreadable storage leaves upgradeability unknown, not absent', async () => {
  const probe = new ContractProbe(fakeCaller({ storageReadable: false }));
  const report = await probe.probe(BASE);

  assert.equal(findingFor(report.findings, 'upgradeable_proxy')?.status, 'unknown');
});

test('issuer control entry points are reported', async () => {
  const code = `0x6080${CONTROL_SELECTORS['pause()']!.slice(2)}${CONTROL_SELECTORS['blacklist(address)']!.slice(2)}`;
  const probe = new ContractProbe(fakeCaller({ code }));
  const report = await probe.probe(BASE);

  const finding = findingFor(report.findings, 'issuer_controls');
  assert.equal(finding?.status, 'present');
  assert.match(finding!.detail, /pause\(\)/);
  assert.match(finding!.detail, /blacklist\(address\)/);
});

test('a fee-on-transfer token is detected with its fee measured', async () => {
  // Delivers 99% of what was sent: a 100bps cut.
  const probe = new ContractProbe(
    fakeCaller({ delivers: (amount) => (amount * 99n) / 100n }),
  );
  const report = await probe.probe(BASE);

  const finding = findingFor(report.findings, 'fee_on_transfer');
  assert.equal(finding?.status, 'present');
  assert.match(finding!.detail, /100bps/);
  // Without absorbing the fee, every payment would read as underpaid.
  assert.match(finding!.detail, /underpaid/);
});

test('a token delivering more than was sent is flagged as rebasing', async () => {
  const probe = new ContractProbe(fakeCaller({ delivers: (amount) => amount * 2n }));
  const report = await probe.probe(BASE);

  assert.equal(findingFor(report.findings, 'rebasing')?.status, 'present');
});

test('without state override support, transfer behaviour is unknown, never absent', async () => {
  // The safety rule that matters most: a check that could not run establishes
  // nothing, so it must not read as a clean result.
  const probe = new ContractProbe(fakeCaller({ supportsOverrides: false }));
  const report = await probe.probe(BASE);

  assert.equal(findingFor(report.findings, 'fee_on_transfer')?.status, 'unknown');
  assert.equal(findingFor(report.findings, 'rebasing')?.status, 'unknown');
  assert.match(findingFor(report.findings, 'fee_on_transfer')!.detail, /state overrides/);
});

test('without a holder, transfer behaviour is unknown', async () => {
  const probe = new ContractProbe(fakeCaller({}));
  const { holder: _omitted, ...withoutHolder } = BASE;
  const report = await probe.probe(withoutHolder);

  assert.equal(findingFor(report.findings, 'fee_on_transfer')?.status, 'unknown');
  assert.match(findingFor(report.findings, 'fee_on_transfer')!.detail, /holder/);
});

test('an unpriceable symbol forces the merchant to set a rate', async () => {
  // The seam back to the pricing engine: no source can quote this, so it cannot be
  // sold at a market rate.
  const probe = new ContractProbe(fakeCaller({ symbol: 'MERCH' }));
  const report = await probe.probe(BASE);
  assert.equal(report.requiresFixedRate, true);
});

test('a symbol the price sources cover does not force a fixed rate', async () => {
  const probe = new ContractProbe(fakeCaller({ symbol: 'USDT' }));
  const report = await probe.probe({ ...BASE, curated: true });
  assert.equal(report.requiresFixedRate, false);
});

test('a curated contract with only issuer controls is approved', async () => {
  // USDT and USDC can both freeze balances. Refusing them would leave nothing
  // worth accepting, so the power is disclosed rather than disqualifying.
  const code = `0x6080${CONTROL_SELECTORS['pause()']!.slice(2)}`;
  const probe = new ContractProbe(fakeCaller({ code, symbol: 'USDT', decimals: 6 }));
  const report = await probe.probe({ ...BASE, curated: true });

  assert.equal(report.verdict, 'approved');
  assert.equal(findingFor(report.findings, 'issuer_controls')?.status, 'present');
});

test('a curated contract with a real defect still goes to review', async () => {
  const probe = new ContractProbe(
    fakeCaller({ symbol: 'USDT', decimals: 6, delivers: (amount) => amount / 2n }),
  );
  const report = await probe.probe({ ...BASE, curated: true });

  assert.equal(report.verdict, 'review');
});

test('a curated contract whose checks could not run is not auto-approvable', async () => {
  const probe = new ContractProbe(
    fakeCaller({ symbol: 'USDT', decimals: 6, supportsOverrides: false }),
  );
  const report = await probe.probe({ ...BASE, curated: true });

  const assessment = assessRisk(report.findings, { curated: true });
  assert.ok(assessment.unknowns.length > 0);
  assert.equal(isAutoApprovable(assessment), false);
});

test('assessRisk orders reasons most severe first', () => {
  const assessment = assessRisk([
    { kind: 'issuer_controls', status: 'present', severity: 'medium', detail: 'pause' },
    { kind: 'symbol_impersonation', status: 'present', severity: 'high', detail: 'claims USDT' },
    { kind: 'rebasing', status: 'absent', severity: 'info', detail: 'fine' },
  ]);

  assert.match(assessment.reasons[0]!, /symbol_impersonation/);
  assert.match(assessment.reasons[1]!, /issuer_controls/);
  // Absent findings are not reasons for anything.
  assert.equal(assessment.reasons.length, 2);
});

test('fee-on-transfer tolerance leaves margin above the observed fee', () => {
  // Some tokens vary the fee by amount or route, so matching it exactly would
  // still classify payments as underpaid.
  const tolerance = toleranceForFeeOnTransfer(100, 50);
  assert.ok(tolerance > 150, `expected margin above 150, got ${tolerance}`);
  assert.throws(() => toleranceForFeeOnTransfer(-1, 50));
});
