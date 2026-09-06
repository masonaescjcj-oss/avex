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
