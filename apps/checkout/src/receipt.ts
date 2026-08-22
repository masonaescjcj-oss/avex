/**
 * The receipt page's own decisions, as pure functions.
 *
 * A receipt is read once and kept. Everything here answers something a payer or their
 * accountant acts on and cannot check by looking at the page: which chain's explorer a
 * hash belongs to, what an overpayment means for what they are owed, whether a figure is
 * the price or the price plus our fee. Rendering can be eyeballed; these cannot.
 */

/**
 * Where a payer verifies the transaction themselves.
 *
 * The single most important thing on a receipt, because it is the only line on it that
 * does not depend on trusting us. Which makes a wrong URL worse than none: sending
 * someone to Etherscan with a BSC hash shows them "not found", and the natural reading of
 * that is that the payment never happened.
 *
 * An unknown chain returns null rather than a guess, and the page then shows the hash on
 * its own — still verifiable by anyone who knows where to look, which is the honest
 * fallback.
 */
export function explorerUrl(chain: string, txHash: string): string | null {
  if (!/^[a-zA-Z0-9_:-]{6,120}$/.test(txHash)) return null;

  const encoded = encodeURIComponent(txHash);
  switch (chain) {
    case 'ethereum':
      return `https://etherscan.io/tx/${encoded}`;
    case 'bsc':
      return `https://bscscan.com/tx/${encoded}`;
    case 'polygon':
      return `https://polygonscan.com/tx/${encoded}`;
    case 'tron':
      return `https://tronscan.org/#/transaction/${encoded}`;
    case 'solana':
      return `https://solscan.io/tx/${encoded}`;
    case 'ton':
      return `https://tonviewer.com/transaction/${encoded}`;
    default:
      return null;
  }
}

/** Chain identifiers as a payer would recognise them. */
export function chainLabel(chain: string): string {
  switch (chain) {
    case 'bsc':
      return 'BNB Chain';
    case 'ton':
      return 'TON';
    case 'tron':
      return 'TRON';
    case 'solana':
      return 'Solana';
    case 'polygon':
      return 'Polygon';
    case 'ethereum':
      return 'Ethereum';
    default:
      return chain;
  }
}

export interface ReceiptVerdict {
  readonly headline: string;
  readonly tone: 'good' | 'warn';
  /** Null when there is nothing outstanding, which is the ordinary case. */
  readonly note: string | null;
}

/**
 * What the receipt says at the top, and whether anything is still outstanding.
 *
 * An overpayment gets a receipt — the money arrived, so the payer is entitled to the
 * record — but it must not print as a clean settlement. Somebody is owed a refund, and a
 * receipt that hid that would be the document the payer was later told to disregard.
 */
export function receiptVerdict(input: {
  readonly status: string;
  readonly amountDue: string;
  readonly amountPaid: string;
  readonly decimals: number;
  readonly symbol: string;
}): ReceiptVerdict {
  if (input.status !== 'overpaid') {
    return { headline: 'Paid in full', tone: 'good', note: null };
  }

  const over = toBigInt(input.amountPaid) - toBigInt(input.amountDue);
  return {
    headline: 'Paid — more than the amount due',
    tone: 'warn',
    note:
      over > 0n
        ? `You sent ${formatUnits(over.toString(), input.decimals)} ${input.symbol} more than ` +
          `the amount due. The merchant owes you the difference.`
        : 'You sent more than the amount due. The merchant owes you the difference.',
  };
}

/**
 * A test receipt has to say so, in the loudest place on the page.
 *
 * The addresses on a test invoice are valid on no chain, so nothing was ever sent — but a
 * document headed "Paid in full" with a real-looking amount is exactly the thing somebody
 * files and later produces as proof of a payment that never existed.
 */
export function isRehearsal(mode: string): boolean {
  return mode !== 'live';
}

/** A smallest-unit amount as a decimal string, exactly, with no trailing zeros. */
export function formatUnits(amount: string, decimals: number): string {
  const value = toBigInt(amount);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');

  const whole = digits.slice(0, digits.length - decimals) || '0';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return `${negative ? '-' : ''}${grouped}`;

  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Micro-dollars as a currency string, without going through a float. */
export function formatUsdMicros(micros: string): string {
  const value = toBigInt(micros);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = ((absolute % 1_000_000n) / 10_000n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${cents}`;
}

/**
 * A malformed figure reads as zero rather than as NaN.
 *
 * The API sends every amount as a string because the values exceed what a double can
 * hold. A bug upstream must not put "NaN" on a document somebody files.
 */
function toBigInt(value: string): bigint {
  const text = (value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  return BigInt(text);
}

/**
 * A canned receipt, for showing the page without a server behind it.
 *
 * Marked `test` on purpose, and that is not a shortcut. A preview receipt that claimed to
 * be a live payment would be exactly the document this page's own warning exists to
 * prevent — so the preview walks into the warning rather than around it, which also means
 * anyone looking at it sees what a rehearsal receipt looks like.
 */
export function previewReceipt() {
  const paidAt = '2026-08-18T09:04:00.000Z';
  return {
    number: 'AVEX-4D2A9C1B',
    status: 'paid',
    merchantName: 'Kian Digital',
    description: 'Order 1042 — annual licence',
    reference: 'order-1042',
    mode: 'test',
    amountFiatMicros: '20000000',
    symbol: 'USDT',
    decimals: 18,
    amountDue: '20100502512562814071',
    amountPaid: '20100502512562814071',
    chain: 'bsc',
    depositAddress: 'AVEXTEST-BSC-9f2c41ab77e05d63c8b1a204',
    memo: null,
    transfers: [],
    feeBps: 0,
    feeIncluded: '0',
    /**
     * A network fee the preview actually shows, because the line exists to be checked.
     *
     * Seventeen basis points of $20.10 is about 3.4 cents — a BSC settlement at a realistic gas
     * price. A preview that zeroed it would render a page with the row hidden, which is the one
     * state nobody needs a preview of.
     */
    networkFeeBps: 17,
    networkFeeIncluded: '34170854271186784',
    issuedAt: '2026-08-18T09:00:00.000Z',
    paidAt,
  };
}
