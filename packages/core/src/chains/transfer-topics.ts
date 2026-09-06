/**
 * Asking a node for our transfers rather than for everybody's.
 *
 * `eth_getLogs` filtered by token contract and the `Transfer` topic asks for every transfer
 * of that token, chain-wide. On a quiet chain that is merely wasteful; on BNB Chain it is
 * tens of thousands of logs for a few minutes of blocks, and a public node answers "limit
 * exceeded" rather than answering. So the watcher stopped at the first poll on every busy
 * chain, which looked exactly like a quiet chain.
 *
 * `Transfer(address indexed from, address indexed to, uint256 value)` indexes the recipient,
 * so it is the third topic and can be filtered on. We know every address worth hearing about
 * — they are the deposit addresses in our own database — and naming them turns a query over
 * the whole chain into a query over our own payments.
 *
 * The batching exists because that list has no fixed size. A node will take an array of
 * topic values but not an unbounded one, so the poll asks in batches. `distinct` on the
 * database side keeps the count near the number of wallets rather than the number of
 * invoices, since a merchant's own wallet is reused by every invoice on it.
 */

/** An address as a topic: 32 bytes, left-padded with zeroes, lowercase. */
export function addressTopic(hexAddress: string): string {
  const hex = hexAddress.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`not a 20-byte hex address: ${hexAddress}`);
  }
  return `0x${'0'.repeat(24)}${hex}`;
}

/**
 * The same, for an address that may not be one.
 *
 * The catalogue and the address book both carry merchant-supplied strings, and one bad row
 * must not stop a chain being watched — that would turn somebody's typo into everybody
 * else's payments going unnoticed.
 */
export function addressTopicOrNull(hexAddress: string): string | null {
  try {
    return addressTopic(hexAddress);
  } catch {
    return null;
  }
}

/**
 * Split into batches of at most `size`.
 *
 * An empty input gives no batches, which is the honest answer: there is nothing to ask for,
 * and a caller that treated it as "ask for everything" would be back to scanning the chain.
 */
export function inBatches<T>(items: readonly T[], size: number): readonly T[][] {
  if (size < 1) throw new Error('batch size must be at least 1');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * How many recipients go in one filter.
 *
 * Well inside what public nodes accept, and small enough that a chunked poll is a handful of
 * calls rather than one enormous one. It is a constant rather than configuration because no
 * deployment has ever needed to tune it, and a knob nobody turns is a knob that is wrong.
 */
export const RECIPIENTS_PER_FILTER = 100;

/**
 * Whether a node refused a log query for being too big, rather than failing for any reason.
 *
 * Public nodes say this in several dialects — BNB Chain's dataseed answers "limit exceeded",
 * TRON "query returned more than 10000 results", geth "query exceeds max block range" — and
 * none of them is a fault of ours to back off from. The watcher's answer is to ask for fewer
 * blocks at a time, which is `narrowedRange`; a query that was refused for size and asked
 * again unchanged after a minute is refused again after a minute, forever, which is exactly
 * how the BNB Chain watcher sat at "10 polls in a row" while a payment waited in the wallet.
 */
export function isLogQueryLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /limit exceeded|block range|more than \d+ results|too many|exceeds? max|response size|query timeout|-3200[15]\b/i.test(
    message,
  );
}

/** The fewest blocks a poll will ever ask for. Below this the query is not the problem. */
export const MIN_POLL_RANGE = 8;

/** Half the range, never below the floor. */
export function narrowedRange(current: number): number {
  return Math.max(MIN_POLL_RANGE, Math.floor(current / 2));
}
