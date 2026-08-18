/**
 * The merchant dashboard's own decisions, as pure functions.
 *
 * Everything here answers a question the page has to get right and that a reader cannot
 * check by looking: whether a merchant is ready to take a live payment, what an invoice
 * status means for them, how close they are to a cheaper commission. Rendering can be
 * eyeballed; these cannot, so they live in a module with tests.
 */

/** Invoice states, as the API reports them. */
export type InvoiceStatus =
  | 'pending'
  | 'confirming'
  | 'paid'
  | 'underpaid'
  | 'overpaid'
  | 'expired';

/**
 * How an invoice status should read to a merchant, and what it implies about action.
 *
 * `tone` drives colour, `needsAttention` drives whether it is surfaced. The distinction
 * matters most for `underpaid` and `overpaid`: both have real money against them and both
 * need a human, which is the opposite of how a naive traffic-light mapping would treat
 * them — green for paid, red for expired, and the two that actually require work rendered
 * as neutral middle states.
 */
export interface StatusView {
  readonly label: string;
  readonly tone: 'good' | 'wait' | 'warn' | 'bad' | 'dead';
  readonly needsAttention: boolean;
  readonly hint: string;
}

export function statusView(status: string): StatusView {
  switch (status) {
    case 'paid':
      return {
        label: 'Paid',
        tone: 'good',
        needsAttention: false,
        hint: 'Settled to your wallet, or queued to be.',
      };
    case 'confirming':
      return {
        label: 'Confirming',
        tone: 'wait',
        needsAttention: false,
        hint: 'The transfer has been seen and is waiting for confirmations.',
      };
    case 'pending':
      return {
        label: 'Awaiting payment',
        tone: 'wait',
        needsAttention: false,
        hint: 'Nothing received yet.',
      };
    case 'underpaid':
      return {
        label: 'Underpaid',
        tone: 'warn',
        needsAttention: true,
        hint: 'Real money arrived but less than the invoice. The payer can send the difference to the same address.',
      };
    case 'overpaid':
      return {
        label: 'Overpaid',
        tone: 'warn',
        needsAttention: true,
        hint: 'More arrived than was due. You owe the payer the difference.',
      };
    case 'expired':
      return {
        label: 'Expired',
        tone: 'dead',
        needsAttention: false,
        hint: 'The window closed. If money arrived late it will still be credited.',
      };
    default:
      /**
       * An unknown status is shown as itself, not mapped onto a guess.
       *
       * A future state rendered as "Paid" because it was the closest match is the kind of
       * mistake that gets goods shipped. Showing the raw value is honest and obviously
       * unfinished.
       */
      return {
        label: status || 'Unknown',
        tone: 'bad',
        needsAttention: true,
        hint: 'This dashboard does not recognise that status. Check the API reference.',
      };
  }
}

/** One thing standing between a merchant and their first live payment. */
export interface SetupStep {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly why: string;
}

export interface SetupInput {
  readonly enabledAssets: number;
  readonly approvedEnabledAssets: number;
  readonly payoutChains: readonly string[];
  readonly assetChains: readonly string[];
  readonly webhookEndpoints: number;
  readonly liveKeys: number;
}

/**
 * What is still missing, in the order it blocks things.
 *
 * A checklist rather than a single "ready" flag, because each of these fails differently
 * and a merchant needs to know which one. The ordering is the order the API refuses in:
 * no enabled asset means nothing to invoice, no payout address means nowhere to settle,
 * and no webhook means payments arrive that nobody is told about.
 */
export function setupSteps(input: SetupInput): readonly SetupStep[] {
  /**
   * Every chain with an enabled asset must have a payout address.
   *
   * Not "at least one payout address": a merchant who enabled USDT on BSC and TON, and
   * added a BSC address only, has a half-configured account whose TON invoices are all
   * refused. Checking the intersection is what catches that.
   */
  const covered = new Set(input.payoutChains);
  const uncovered = input.assetChains.filter((chain) => !covered.has(chain));

  return [
    {
      id: 'assets',
      title: 'Enable a currency',
      done: input.approvedEnabledAssets > 0,
      why:
        input.enabledAssets > 0 && input.approvedEnabledAssets === 0
          ? 'The currencies you enabled are still in review, so they cannot be invoiced in yet.'
          : 'Choose which coins you accept. Nothing can be invoiced until at least one is enabled and approved.',
    },
    {
      id: 'payouts',
      title: 'Add a payout address for every chain',
      done: input.assetChains.length > 0 && uncovered.length === 0,
      why:
        uncovered.length > 0
          ? `Invoices on ${uncovered.join(', ')} will be refused: funds can only move to an address you configured.`
          : 'Funds go straight from the payer to your own wallet, so we need one address per chain.',
    },
    {
      id: 'webhook',
      title: 'Add a webhook endpoint',
      done: input.webhookEndpoints > 0,
      why:
        'Without one, payments arrive and nothing tells your system. Polling works, but a payer who has paid and sees nothing will contact you.',
    },
    {
      id: 'live-key',
      title: 'Create a live API key',
      done: input.liveKeys > 0,
      why: 'Test keys cannot take real money, by design. You need a live key to go live.',
    },
  ];
}

/** How close a merchant is to the next rung of the commission ladder. */
export interface TierProgressView {
  readonly processedUsd: string;
  /** 0–100, clamped. Drives a bar, so it must never exceed its track. */
  readonly percent: number;
  /** True once this period's volume already earns a cheaper rate than they pay now. */
  readonly earned: boolean;
  readonly message: string;
}

/**
 * The period's volume, as progress towards a cheaper rate.
 *
 * This replaced a bar showing how much of a $1,500 free allowance was left, and the
 * change is not cosmetic. That bar counted *down* towards a bill: filling it was bad
 * news, and a merchant doing well watched it turn red. With no monthly fee there is no
 * bill to count down to, and the same volume figure now means the opposite — filling
 * this bar is how a merchant reaches 0.45%.
 */
export function tierProgressView(input: {
  readonly processedUsdMicros: string;
  /** What they pay today. */
  readonly feeBps: number;
  /** What this period's volume so far would earn, from the API. */
  readonly wouldEarnBps: number;
  readonly negotiated: boolean;
  readonly nextTier: { readonly bps: number; readonly fromUsdMicros: string } | null;
}): TierProgressView {
  const processed = toBigInt(input.processedUsdMicros);
  const processedUsd = usd(processed);
  const earned = input.wouldEarnBps < input.feeBps;

  /**
   * A negotiated rate first, because for those merchants the bar is meaningless.
   *
   * Showing them 4% of the way to a rung the ladder will never grant them would be a
   * promise we have already decided not to keep.
   */
  if (input.negotiated) {
    return {
      processedUsd,
      percent: 100,
      earned: false,
      message: `${processedUsd} processed this period, at your agreed rate.`,
    };
  }

  if (!input.nextTier) {
    return {
      processedUsd,
      percent: 100,
      earned: false,
      message: `${processedUsd} processed this period. ${percentOf(
        input.feeBps,
      )} is the lowest rate we publish.`,
    };
  }

  const target = toBigInt(input.nextTier.fromUsdMicros);
  /**
   * Clamped at 100, and zero when the target is zero.
   *
   * A bar wider than its track is a visual bug, but the reason to clamp here rather than
   * in CSS is that the number is also read aloud by a screen reader — "142 per cent of
   * the way to your next rate" is not a sentence that helps anyone.
   */
  const percent = target === 0n ? 100 : Math.min(100, Number((processed * 100n) / target));

  if (earned) {
    // Deliberately future-tense. The rate changes when the period closes, and a merchant
    // told "you are on 0.45%" who then reads 0.5% on their next invoice was misled.
    return {
      processedUsd,
      percent: 100,
      earned: true,
      message:
        `${processedUsd} processed this period — enough for ${percentOf(input.wouldEarnBps)}, ` +
        `which starts when the period closes.`,
    };
  }

  const remaining = target > processed ? target - processed : 0n;
  return {
    processedUsd,
    percent,
    earned: false,
    message: `${usd(remaining)} more this period reaches ${percentOf(input.nextTier.bps)}.`,
  };
}

/**
 * The published ladder, with the merchant's own rung marked.
 *
 * Built from the ladder the API returns rather than from a copy written here. Two lists
 * of prices eventually disagree, and the merchant is the one who finds out.
 */
export function ladderRows(
  ladder: readonly { readonly bps: number; readonly fromUsdMicros: string }[],
  feeBps: number,
  negotiated: boolean,
): readonly {
  readonly rate: string;
  readonly from: string;
  readonly current: boolean;
}[] {
  return ladder.map((rung) => ({
    rate: percentOf(rung.bps),
    from: toBigInt(rung.fromUsdMicros) === 0n ? 'from your first payment' : `over ${usd(toBigInt(rung.fromUsdMicros))} a month`,
    // A negotiated rate is not on the ladder, so marking a rung would be wrong even when
    // the numbers happen to coincide.
    current: !negotiated && rung.bps === feeBps,
  }));
}

/**
 * A commission in basis points, as the money it actually costs.
 *
 * Basis points are the unit the ladder is written in; dollars per thousand is the unit a
 * merchant thinks in. Showing only the first makes them do arithmetic to find out what
 * they are paying.
 */
export function commissionParts(feeBps: number): { readonly percent: string; readonly perThousand: string } {
  const perThousand = (1000 * feeBps) / 10_000;
  return {
    percent: percentOf(feeBps),
    perThousand: `$${trimZeros(perThousand.toFixed(2))} per $1,000`,
  };
}

/** Basis points as a percentage, without trailing zeros: 45 → "0.45%". */
function percentOf(bps: number): string {
  return `${trimZeros((bps / 100).toFixed(2))}%`;
}

/**
 * Both halves in one line, for somewhere with room.
 *
 * The overview uses the parts instead: at headline size the joined string wraps onto two
 * lines and shouts louder than the figure beside it, which is the merchant's own volume.
 * The percentage is the headline and the money is the explanation, not the reverse.
 */
export function commissionLabel(feeBps: number): string {
  const parts = commissionParts(feeBps);
  return `${parts.percent} — ${parts.perThousand}`;
}

/**
 * Whether an API key should be treated as dangerous to display.
 *
 * A live key is the one that moves real money, so the page marks it differently. Read
 * from the prefix rather than from a field, because the prefix is what the API enforces.
 */
export function keyMode(displayPrefix: string): 'test' | 'live' | 'unknown' {
  if (displayPrefix.startsWith('ak_test_')) return 'test';
  if (displayPrefix.startsWith('ak_live_')) return 'live';
  return 'unknown';
}

function toBigInt(value: string): bigint {
  const text = (value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  return BigInt(text);
}

/** Micro-dollars as a currency string, without going through a float. */
function usd(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const cents = (absolute % 1_000_000n) / 10_000n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${cents.toString().padStart(2, '0')}`;
}

function trimZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}
