
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
  /**
   * Chains with somewhere for money to land: a wallet of the merchant's own, or a payout
   * address on a chain with forwarders. Either satisfies the step, and the page unions them.
   */
  readonly payoutChains: readonly string[];
  readonly assetChains: readonly string[];
  readonly webhookEndpoints: number;
  readonly liveKeys: number;
  /** Whether this account has a confirmed authenticator. */
  readonly twoFactorEnabled: boolean;
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
   * Every chain with an enabled asset must have somewhere for the money to land.
   *
   * Not "at least one": a merchant who enabled USDT on BSC and TON, and added a BSC wallet
   * only, has a half-configured account whose TON invoices are all refused. Checking the
   * intersection is what catches that.
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
      /**
       * Before the payout address, because it is what the payout address needs.
       *
       * Adding one is elevation-gated, so an account with no authenticator is refused —
       * and the refusal used to be the first a merchant heard of it, on a page with
       * nowhere to go and fix it. Listing it here in the order the API refuses in is what
       * makes the sequence followable.
       */
      id: 'two-factor',
      title: 'Turn on two-factor authentication',
      done: input.twoFactorEnabled,
      why: input.twoFactorEnabled
        ? 'An authenticator app is enrolled on this account.'
        : 'Payout addresses, live keys and team changes all need it — they are the ' +
          'requests that move money or grant access. Set it up on the Security tab.',
    },
    {
      id: 'payouts',
      title: 'Add a wallet of your own for every chain',
      done: input.assetChains.length > 0 && uncovered.length === 0,
      why:
        uncovered.length > 0
          ? `Invoices on ${uncovered.join(', ')} will be refused: there is nowhere on that chain for the money to land.`
          : 'Your customers pay straight into it — no contract of ours in the way, and no network fee. A payout address works too, where we have contracts deployed.',
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

/** What the security panel shows, given what the session knows about itself. */
export interface SecurityView {
  /** One line naming the state, for the panel head. */
  readonly headline: string;
  readonly tone: 'good' | 'warn';
  /** The label on the button that begins an enrolment. */
  readonly enrollLabel: string;
  /**
   * Set when beginning an enrolment would replace one that already works, so the page
   * can say what it costs before it is clicked. Null when there is nothing to lose.
   */
  readonly replaceWarning: string | null;
  /** Whether this session has a factor outstanding that it could prove now. */
  readonly needsElevation: boolean;
  /** Whether signing other sessions out is available, and why not when it is not. */
  readonly canRevokeOthers: boolean;
  readonly revokeNote: string;
}

/**
 * The security panel's states, decided here rather than in the page.
 *
 * Two booleans, and each pair means something different to the person reading it:
 * nothing enrolled at all, enrolled and proven, and enrolled but not proven in this
 * session — which is exactly where confirming a fresh enrolment leaves you, since it
 * clears the proven factor from every session including this one. A panel that drew
 * only "on" or "off" would say "on" there and offer a button that fails.
 */
export function securityView(input: {
  readonly totpEnabled: boolean;
  readonly mfaComplete: boolean;
}): SecurityView {
  if (!input.totpEnabled) {
    return {
      headline: 'Off',
      tone: 'warn',
      enrollLabel: 'Set up an authenticator app',
      replaceWarning: null,
      needsElevation: false,
      canRevokeOthers: false,
      revokeNote: 'Available once an authenticator is enrolled.',
    };
  }

  return {
    headline: input.mfaComplete ? 'On' : 'On — this session has not been unlocked',
    tone: input.mfaComplete ? 'good' : 'warn',
    enrollLabel: 'Move to a different authenticator app',
    replaceWarning:
      'The app you have now keeps working until you enter a code from the new one. ' +
      'Nothing changes if you do not finish.',
    needsElevation: !input.mfaComplete,
    canRevokeOthers: input.mfaComplete,
    revokeNote: input.mfaComplete
      ? 'Signs out every other browser and device. This one stays signed in.'
      : 'Enter a code from your authenticator app first.',
  };
}

/**
 * What a merchant can do about one currency, and what is stopping them.
 *
 * Six states rather than a checkbox, because "off" has six different causes and five of
 * them are not the merchant's to fix. A row that showed only on/off would leave somebody
 * toggling a switch that cannot help — the contract is in review, or we have stopped
 * offering the chain — and the natural reading of a switch that does nothing is that the
 * product is broken.
 */
export type AssetState =
  /** Everything is in place. Invoices in this currency will open. */
  | 'accepting'
  /** Available, and they have simply not turned it on. The one they can act on. */
  | 'off'
  /** Enabled, but nowhere to settle it: invoices on this chain are refused. */
  | 'needs_payout'
  /** Enabled, but nothing prices it and they have set no rate — or it lapsed. */
  | 'needs_rate'
  /** We are still checking the contract. */
  | 'in_review'
  /** We refused the contract. */
  | 'blocked'
  /** We have stopped offering it. Nothing the merchant does changes that. */
  | 'withdrawn';

export interface AssetStance {
  readonly state: AssetState;
  readonly label: string;
  readonly tone: 'good' | 'wait' | 'warn' | 'bad' | 'dead';
  readonly hint: string;
  /** False when toggling it could not help, so the control is not offered. */
  readonly canToggle: boolean;
}

export function assetStance(
  asset: {
    readonly verdict: string;
    readonly listed?: boolean;
    readonly enabled: boolean;
    readonly requiresFixedRate?: boolean;
    readonly pricingMode?: string | null;
    readonly fixedRateValidUntil?: string | null;
  },
  hasPayoutAddress: boolean,
  now: number = Date.now(),
): AssetStance {
  /**
   * Ordered by who can act, hardest first.
   *
   * A merchant reading this row wants one sentence telling them whether it is their move.
   * So anything we have decided comes before anything they have decided: there is no point
   * telling somebody their payout address is missing for a currency we have blocked.
   */
  if (asset.verdict === 'blocked') {
    return {
      state: 'blocked',
      label: 'Refused',
      tone: 'bad',
      hint: 'We could not accept this contract. Nothing here will change that.',
      canToggle: false,
    };
  }

  if (asset.listed === false) {
    return {
      state: 'withdrawn',
      label: 'Not offered',
      tone: 'dead',
      /**
       * Explicitly ours, not theirs, and explicitly about the chain rather than the token.
       * A merchant told only "unavailable" will go looking at their own configuration.
       */
      hint:
        'AVEX is not accepting this currency at the moment — usually because the chain ' +
        'itself is paused on our side. Invoices already open still complete.',
      canToggle: false,
    };
  }

  if (asset.verdict !== 'approved') {
    return {
      state: 'in_review',
      label: 'In review',
      tone: 'wait',
      hint: 'We are checking the contract. You will be told when it is decided.',
      canToggle: false,
    };
  }

  if (!asset.enabled) {
    return {
      state: 'off',
      label: 'Off',
      tone: 'dead',
      hint: 'Available. Turn it on to accept it.',
      canToggle: true,
    };
  }

  /**
   * A missing payout address beats a missing rate.
   *
   * Both refuse an invoice, but only one of them means the money would have nowhere to go.
   * Naming the rate first would have somebody set a rate and still be refused.
   */
  if (!hasPayoutAddress) {
    return {
      state: 'needs_payout',
      label: 'Needs a wallet',
      tone: 'warn',
      hint: 'On. Invoices are refused until you add a wallet of your own for this chain — or a payout address, where we have contracts there.',
      canToggle: true,
    };
  }

  const rateLapsed =
    asset.pricingMode === 'fixed_rate' &&
    asset.fixedRateValidUntil !== null &&
    asset.fixedRateValidUntil !== undefined &&
    Date.parse(asset.fixedRateValidUntil) <= now;

  if (asset.requiresFixedRate === true && (asset.pricingMode !== 'fixed_rate' || rateLapsed)) {
    return {
      state: 'needs_rate',
      label: rateLapsed ? 'Your rate has lapsed' : 'Needs your rate',
      tone: 'warn',
      /**
       * Said plainly because the reason is unusual and merchants do not expect it: no
       * market quotes this token, so there is no price for us to use and refusing to guess
       * one is deliberate.
       */
      hint:
        'On, but nothing on the market prices this currency, so the rate has to be yours. ' +
        'Invoices are refused until you set one.',
      canToggle: true,
    };
  }

  if (rateLapsed) {
    return {
      state: 'needs_rate',
      label: 'Your rate has lapsed',
      tone: 'warn',
      hint: 'On, but the rate you set has expired. Invoices are refused until you renew it.',
      canToggle: true,
    };
  }

  return {
    state: 'accepting',
    label: 'Accepting',
    tone: 'good',
    hint: 'On, priced, and settling to your address.',
    canToggle: true,
  };
}

/**
 * Currencies grouped by chain, in the order a merchant reads them.
 *
 * By chain because that is how the decisions cluster — a payout address is per chain, and
 * so is our own readiness — and within a chain by whether it needs attention, so a lapsed
 * rate is not three rows below an untouched one nobody cares about.
 */
export function groupAssetsByChain<
  T extends { readonly chain: string; readonly symbol: string },
>(
  assets: readonly T[],
  rank: (asset: T) => number,
): readonly { readonly chain: string; readonly assets: readonly T[] }[] {
  const byChain = new Map<string, T[]>();
  for (const asset of assets) {
    const bucket = byChain.get(asset.chain);
    if (bucket) bucket.push(asset);
    else byChain.set(asset.chain, [asset]);
  }

  return [...byChain.entries()]
    .map(([chain, group]) => ({
      chain,
      assets: [...group].sort(
        (left, right) => rank(left) - rank(right) || left.symbol.localeCompare(right.symbol),
      ),
    }))
    .sort((left, right) => left.chain.localeCompare(right.chain));
}

/**
 * How urgently a row wants looking at. Lower sorts first.
 *
 * Something on but refusing invoices is the only genuinely urgent case: the merchant
 * believes they are accepting that currency and they are not.
 */
export function assetUrgency(state: AssetState): number {
  switch (state) {
    case 'needs_payout':
    case 'needs_rate':
      return 0;
    case 'accepting':
      return 1;
    case 'off':
      return 2;
    case 'in_review':
      return 3;
    case 'withdrawn':
      return 4;
    case 'blocked':
      return 5;
  }
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

/** How the two answers to "who pays the commission" read to a merchant. */
export interface FeePayerChoice {
  readonly value: 'merchant' | 'payer';
  readonly label: string;
  readonly detail: string;
  readonly current: boolean;
}

/**
 * The choice, spelled out in what it does to a $100 order.
 *
 * Written as an example rather than as a rule because the rule is easy to read the wrong
 * way round. "The customer pays the fee" sounds like the customer is billed separately;
 * what actually happens is the invoice asks for more. A worked figure removes the
 * ambiguity in a way no phrasing of the abstraction does.
 */
export function feePayerChoices(feeBps: number, current: 'merchant' | 'payer'): readonly FeePayerChoice[] {
  const onHundred = (100 * feeBps) / 10_000;
  const fee = `$${trimZeros(onHundred.toFixed(2))}`;
  const gross = `$${trimZeros((100 + onHundred).toFixed(2))}`;

  return [
    {
      value: 'merchant',
      label: 'You absorb it',
      detail: `A $100 order: your customer sends $100 and you receive $${trimZeros(
        (100 - onHundred).toFixed(2),
      )}.`,
      current: current === 'merchant',
    },
    {
      value: 'payer',
      label: 'Your customer pays it',
      detail:
        feeBps === 0
          ? 'Nothing to pass on while your commission is zero, so this changes nothing.'
          : `A $100 order: your customer sends ${gross} and you receive $100. The ${fee} is ` +
            'shown to them on the checkout as its own line.',
      current: current === 'payer',
    },
  ];
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

/** One line of the balance statement, as the panel shows it. */
export interface LedgerRow {
  readonly kind: string;
  /** What it means, in the merchant's words rather than ours. */
  readonly label: string;
  readonly amount: string;
  /** True when the entry increased what they owe. */
  readonly owed: boolean;
  readonly when: string;
}

export interface BalanceView {
  /** The figure, signed and formatted: `-$0.50` when something is owed. */
  readonly amount: string;
  /** One line saying what the number means. Never a bare figure. */
  readonly headline: string;
  readonly detail: string;
  /** `owed` when they are behind, `clear` when they are not, `blocked` past the limit. */
  readonly tone: 'clear' | 'owed' | 'blocked';
  /** Whether to show the statement at all. */
  readonly hasHistory: boolean;
}

const LEDGER_LABELS: Readonly<Record<string, string>> = {
  accrual: 'Commission on a TRON payment',
  accrual_reversed: 'Commission returned — payment reversed',
  recovery: 'Cleared by a later invoice',
  settlement: 'You paid us directly',
  adjustment: 'Adjustment',
};

/**
 * The balance, as a sentence rather than a number.
 *
 * A negative figure on a payments dashboard is alarming in a way that needs explaining
 * immediately: a merchant who sees `-$0.50` with no context has to decide whether we have
 * lost their money. So the headline always says what it is, and the ordinary case — a few
 * cents owed, clearing itself from the next invoice — says so in those words rather than
 * looking like a debt notice.
 *
 * Three states, because they need three different things from the reader. Clear needs
 * nothing. Owed needs to be understood but not acted on. Blocked needs action, and says
 * exactly which action.
 */
export function balanceView(input: {
  /** Signed micro-dollars, as a string. Negative means owed. */
  readonly balanceUsdMicros: string;
  readonly creditLimitUsdMicros: string;
  readonly canInvoiceOnAccruingChains: boolean;
  readonly entryCount: number;
  /** Injected so the module stays pure; the page passes `formatUsdMicros`. */
  readonly formatUsd: (micros: string) => string;
}): BalanceView {
  const balance = BigInt(input.balanceUsdMicros);
  const amount = input.formatUsd(input.balanceUsdMicros);
  const hasHistory = input.entryCount > 0;

  if (!input.canInvoiceOnAccruingChains) {
    return {
      amount,
      headline: 'New TRON invoices are paused',
      detail:
        `You owe ${input.formatUsd((-balance).toString())}, which is past the ` +
        `${input.formatUsd(input.creditLimitUsdMicros)} limit. Settle it, or take payments ` +
        'on a chain where our commission comes out of the payment itself — those invoices ' +
        'clear the balance as they are paid.',
      tone: 'blocked',
      hasHistory,
    };
  }

  if (balance >= 0n) {
    return {
      amount,
      headline: 'Nothing owed',
      detail:
        'On most chains our commission comes out of the payment itself, so there is nothing ' +
        'to settle. A balance only appears when you take payments on TRON.',
      tone: 'clear',
      hasHistory,
    };
  }

  return {
    amount,
    headline: 'Owed on TRON payments',
    detail:
      'TRON payments go straight to your own wallet, so there is no transaction of ours to ' +
      'take the commission out of. It is charged here instead, and clears itself: your next ' +
      'invoice on another chain carries a slightly higher fee until the balance is back to ' +
      'zero. Nothing is billed to you separately, and your customers never see it.',
    tone: 'owed',
    hasHistory,
  };
}

/**
 * The statement, oldest facts made legible.
 *
 * The sign is not left to the reader to work out from a minus. Every gateway statement that
 * shows raw signed numbers produces the same support question — "is this a charge or a
 * credit" — and the answer is already known here.
 */
export function ledgerRows(
  entries: readonly {
    readonly kind: string;
    readonly amountUsdMicros: string;
    readonly createdAt: string;
  }[],
  formatUsd: (micros: string) => string,
): readonly LedgerRow[] {
  return entries.map((entry) => {
    const amount = BigInt(entry.amountUsdMicros);
    return {
      kind: entry.kind,
      label: LEDGER_LABELS[entry.kind] ?? entry.kind,
      /**
       * The magnitude, with the direction carried by `owed` instead of a sign.
       *
       * A column of `-$0.50` and `$0.50` is read wrong at a glance, and at a glance is how a
       * statement is read.
       */
      amount: formatUsd((amount < 0n ? -amount : amount).toString()),
      owed: amount < 0n,
      when: entry.createdAt,
    };
  });
}

