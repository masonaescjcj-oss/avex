import type { ChainId } from '../types.js';
import { chainConfig } from './registry.js';
import { isTronAddress, normalizeTronAddress } from './tron/address.js';

/**
 * One address, one comparison key.
 *
 * Two systems have to agree on whether a transfer's recipient is a deposit address we handed
 * out: the watcher, which reads the address off a log, and the database, which stored it when
 * the invoice was created. They rarely agree on spelling — an EVM address is stored in EIP-55
 * mixed case because that is what a merchant reads, and comes back from an RPC lowercase.
 *
 * Until now that was reconciled by lowercasing both sides everywhere. Correct for hex, and
 * quietly wrong for every chain whose addresses are base58: folding those destroys them, and
 * two distinct valid addresses can fold onto the same string — which, in a deposit-address
 * lookup, is a payment credited to somebody else's invoice. See `addressCase` in the registry.
 *
 * So the reconciliation moves here, where it can be per-chain, and the two call sites ask for
 * a key rather than deciding for themselves.
 */

/** Whether this chain's addresses may be compared with the case folded away. */
export function foldsAddressCase(chain: ChainId): boolean {
  return chainConfig(chain).addressCase === 'insensitive';
}

/**
 * The key to compare an address by, on this chain.
 *
 * For hex chains: lowercase, which is the existing behaviour and the correct one. For TRON:
 * the canonical Base58Check form, so that the 21-byte hex a node returns and the `T…` string
 * a merchant gave us reduce to the same key — the same reconciliation the fold was doing,
 * done in a way that does not corrupt the address. For anything else case-significant: the
 * address as given, trimmed, because we have no codec for it yet and inventing a
 * normalisation would be worse than requiring an exact match.
 */
export function addressKey(chain: ChainId, address: string): string {
  const trimmed = address.trim();
  if (foldsAddressCase(chain)) return trimmed.toLowerCase();

  /**
   * TRON only, and only when it really parses.
   *
   * An unparseable string is returned as given rather than thrown on: this function is called
   * with whatever a chain reported, and the caller's contract is "no invoice owns this",
   * not "crash the watcher". A string that is not an address matches no stored address, which
   * is the right answer arrived at without an exception.
   */
  if (chain === 'tron' && isTronAddress(trimmed)) return normalizeTronAddress(trimmed);

  return trimmed;
}
