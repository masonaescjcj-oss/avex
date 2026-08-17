import type { AssetVerdict, Finding, FindingKind, Severity } from './types.js';

/**
 * Turning findings into a verdict.
 *
 * Pure, so the policy is inspectable and testable without a chain. The rules are
 * deliberately conservative in one direction: `approved` is never reached by
 * accumulating clean checks. It is reserved for contracts on the curated list.
 * Everything a merchant submits lands in `review` at best — a human decides
 * whether an unknown contract may credit invoices, because the cost of being
 * wrong is paid in other people's money.
 */

/** Findings that make a contract unusable regardless of review. */
const BLOCKING: readonly FindingKind[] = ['no_code', 'not_erc20', 'zero_supply'];

export interface RiskAssessment {
  readonly verdict: AssetVerdict;
  /** Ordered most severe first, for the review queue. */
  readonly reasons: readonly string[];
  /** Checks that could not run. Each one on its own prevents auto-approval. */
  readonly unknowns: readonly FindingKind[];
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  blocking: 0,
  high: 1,
  medium: 2,
  info: 3,
};

export function assessRisk(
  findings: readonly Finding[],
  options: { readonly curated?: boolean } = {},
): RiskAssessment {
  const material = findings.filter((finding) => finding.status !== 'absent');
  const sorted = [...material].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const reasons = sorted.map((finding) => `${finding.kind}: ${finding.detail}`);

  const blocked = findings.some(
    (finding) => finding.status === 'present' && BLOCKING.includes(finding.kind),
  );
  if (blocked) return { verdict: 'blocked', reasons, unknowns: [] };

  // A decimals value outside the sane range cannot be worked around by a reviewer.
  const decimalsBroken = findings.some(
    (finding) => finding.kind === 'decimals_unusual' && finding.severity === 'blocking',
  );
  if (decimalsBroken) return { verdict: 'blocked', reasons, unknowns: [] };

  const unknowns = findings
    .filter((finding) => finding.status === 'unknown')
    .map((finding) => finding.kind);

  /**
   * The curated list is the only path to `approved`, and even then a genuine
   * problem still forces review.
   *
   * A curated entry carries `issuer_controls` by design — USDT and USDC can both
   * freeze balances, and refusing them would leave the gateway with nothing worth
   * accepting. That power is disclosed to merchants rather than treated as a fault.
   */
  if (options.curated) {
    const disqualifying = material.filter(
      (finding) =>
        finding.kind !== 'issuer_controls' &&
        finding.kind !== 'upgradeable_proxy' &&
        finding.severity !== 'info',
    );
    return {
      verdict: disqualifying.length === 0 ? 'approved' : 'review',
      reasons,
      unknowns,
    };
  }

  return { verdict: 'review', reasons, unknowns };
}

/**
 * Whether a report may be enabled without a human looking at it.
 *
 * Separate from the verdict so the caller cannot accidentally treat `review` as
 * permission by reading only the happy path.
 */
export function isAutoApprovable(assessment: RiskAssessment): boolean {
  return assessment.verdict === 'approved' && assessment.unknowns.length === 0;
}

/**
 * Extra tolerance a fee-on-transfer token needs on top of the invoice default.
 *
 * A token that takes a cut in transit delivers less than was sent, so matching
 * against the invoiced amount would classify every payment as underpaid. The
 * tolerance has to absorb the fee, which means a reviewer must record what it is.
 */
export function toleranceForFeeOnTransfer(feeBps: number, baseToleranceBps: number): number {
  if (feeBps < 0) throw new Error('feeBps must not be negative');
  // A margin above the observed fee, since some tokens vary it by amount or route.
  return baseToleranceBps + feeBps + 25;
}
