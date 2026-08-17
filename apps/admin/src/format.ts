/**
 * Formatting for the admin panel.
 *
 * Every function here is pure, and they are in a module rather than in the page
 * because these are the things that quietly lie. A panel that displays a rounded
 * token balance, or an age of "NaN", or a truncated address that matches a different
 * address, is worse than one that displays nothing — an operator acts on what they
 * read.
 *
 * Nothing here converts a token amount through `number`. An 18-decimal amount
 * exceeds what a double holds exactly, so amounts arrive as decimal strings and are
 * formatted by moving the decimal point in the string itself.
 */

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/**
 * A smallest-unit amount as a human decimal, exactly.
 *
 * `formatUnits('20000000000000000000', 18)` is `'20'`, and
 * `formatUnits('1', 18)` is `'0.000000000000000001'` rather than `'0'`. Rounding
 * the second to zero would tell an operator that nothing arrived.
 */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) throw new FormatError(`not an integer amount: ${amount}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new FormatError(`unreasonable decimals: ${decimals}`);
  }

  const negative = amount.startsWith('-');
  const digits = negative ? amount.slice(1) : amount;
  if (decimals === 0) return (negative ? '-' : '') + stripLeadingZeros(digits);

  const padded = digits.padStart(decimals + 1, '0');
  const whole = stripLeadingZeros(padded.slice(0, padded.length - decimals));
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');

  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return (negative ? '-' : '') + body;
}

/**
 * The same, with thousands separators on the whole part.
 *
 * Grouping only the integer side, because grouping a fraction is not a convention
 * anyone reads and a token amount's fraction is long.
 */
export function formatUnitsGrouped(amount: string, decimals: number): string {
  const plain = formatUnits(amount, decimals);
  const negative = plain.startsWith('-');
  const body = negative ? plain.slice(1) : plain;
  const [whole, fraction] = body.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + (fraction === undefined ? grouped : `${grouped}.${fraction}`);
}

/**
 * Micro-dollars as a dollar figure.
 *
 * Money the platform spends and earns is stored at 1e6 so that a cent is always
 * exact. Displayed to four places when small, because a settlement costing
 * $0.0141 rounds to $0.01 and the whole point of the fee engine is that the
 * difference matters.
 */
export function formatUsdMicros(micros: string): string {
  const whole = formatUnits(micros, 6);
  const value = whole.includes('.') ? whole : `${whole}.0`;
  const [integer, fraction = ''] = value.split('.');

  const small = (integer === '0' || integer === '-0') && fraction.length > 2;
  const places = small ? 4 : 2;
  const padded = fraction.padEnd(places, '0').slice(0, places);
  const grouped = (integer ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return grouped.startsWith('-')
    ? `-$${grouped.slice(1)}.${padded}`
    : `$${grouped}.${padded}`;
}

/** Wei as gwei, which is the unit gas is actually discussed in. */
export function formatGwei(wei: string): string {
  const gwei = formatUnits(wei, 9);
  // Three places is enough to distinguish 0.047 gwei from 0.05, which is the
  // difference between a $0.014 settlement and a $0.015 one.
  if (!gwei.includes('.')) return `${gwei} gwei`;
  const [whole, fraction = ''] = gwei.split('.');
  return `${whole}.${fraction.slice(0, 3).padEnd(3, '0')} gwei`;
}

/**
 * A duration as the coarsest unit that is still true.
 *
 * "3m" rather than "180s", but never "0m" — sub-minute reads as "just now", because
 * a watcher polled four seconds ago is healthy and "0m" looks like a stopped clock.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'just now';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** How long ago an ISO timestamp was. Null and unparseable both read as an em dash. */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  return at > now ? 'just now' : formatDuration(now - at);
}

/**
 * An address shortened for a table, keeping both ends.
 *
 * Both ends, never one: operators compare addresses by eye, and two different
 * addresses sharing a prefix are common enough — vanity addresses, and every
 * contract deployed by the same factory — that a leading fragment alone can match
 * the wrong thing.
 */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** A transaction hash, shortened harder — nobody reads the middle of one. */
export function shortenHash(hash: string): string {
  return shortenAddress(hash, 10, 6);
}

/**
 * Turn a dotted action name into something readable, without losing the original.
 *
 * `payout_address.change_requested` becomes `payout address · change requested`. The
 * dot is kept as a separator because the prefix is what the audit filter searches
 * on, and hiding the structure would hide how to search.
 */
export function humanizeAction(action: string): string {
  return action
    .split('.')
    .map((part) => part.replace(/_/g, ' '))
    .join(' · ');
}

function stripLeadingZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, '');
  return trimmed.length > 0 ? trimmed : '0';
}
