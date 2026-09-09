import type { BlockRef, BlockSource } from '../../watch/Watcher.js';

/**
 * toncenter's v3 indexer, and the watcher's view of TON's head.
 *
 * ## Why an indexer and not a node
 *
 * On TON the thing we need to know — "what has been paid into this wallet, and with what
 * comment" — is not a question a node answers. A jetton transfer does not arrive at the
 * merchant's address at all: it arrives at that wallet's *jetton wallet*, a separate contract
 * whose address is a hash of its own code and data. Finding it from a node means building
 * TL-B cells and computing state-init hashes, and reading the comment means walking a
 * `forward_payload` cell. The v3 indexer has already done both: `/jetton/transfers` takes an
 * owner address, gives the amount, the jetton master, the sender's owner, and the comment
 * already decoded.
 *
 * That is the whole reason this adapter is a few hundred lines and not a few thousand.
 *
 * ## The scalar is a timestamp, and that is deliberate
 *
 * Everything above the adapter seam keeps a single increasing number per chain: a block on an
 * EVM chain, a slot on Solana. TON has two candidates and neither fits. Logical time is
 * exact and monotonic but around 10¹⁴, which overflows the integer column payments are
 * recorded in. Masterchain seqno fits and is a real block number, but the jetton transfer
 * index is not keyed by it and does not return it, so a transfer could not be placed on that
 * scale at all.
 *
 * What both endpoints do return, and both accept as a filter, is the transaction's unix time.
 * So that is the number: a cursor of "everything up to this second". It is monotonic, it is
 * what the index is sorted by, and its one real limit is that the column holding it is a
 * 32-bit integer, which stops working in 2038.
 *
 * ## Finality
 *
 * TON commits blocks by BFT agreement, so a transaction the indexer returns is in a block
 * that will not be taken back. There is no depth to wait for, which is why the registry says
 * one confirmation at any value and no reorgs — and why `blockAt` throws rather than
 * answering: on a timestamp scale there is no block to fetch, and a null answer would be read
 * by the watcher as a rollback and trigger a rewind that nothing here needs.
 */

export interface TonApiConfig {
  /** The v3 base, e.g. `https://toncenter.com/api/v3`. */
  readonly apiUrl: string;
  /** Raises the rate limit well above the anonymous one. Sent as `X-API-Key`. */
  readonly apiKey?: string | undefined;
}

interface MasterchainInfo {
  readonly last: {
    readonly seqno: number;
    readonly root_hash: string;
    /** A string in this response and a number in others, so both are handled. */
    readonly gen_utime: string | number;
  };
}

export class TonApi implements BlockSource {
  constructor(private readonly config: TonApiConfig) {}

  /** The time of the newest committed masterchain block, which is the scan's ceiling. */
  async utime(): Promise<number> {
    const info = await this.get<MasterchainInfo>('masterchainInfo', {});
    return Number(info.last.gen_utime);
  }

  /**
   * The head: the newest masterchain block's time, and its root hash.
   *
   * The hash is real and is the block's own, so nothing here invents an identity — it is
   * simply never compared, because reorg detection is off for this chain.
   */
  async head(): Promise<BlockRef> {
    const info = await this.get<MasterchainInfo>('masterchainInfo', {});
    return { number: Number(info.last.gen_utime), hash: info.last.root_hash };
  }

  /**
   * Refused, loudly, because the number it would be asked about is a timestamp.
   *
   * Never called while the registry says this chain has no reorgs: the watcher's block memory
   * is zero, so it remembers nothing and compares nothing. If that is ever changed, this
   * throws and says why, rather than returning null and having the watcher read every
   * timestamp as a rolled-back block.
   */
  async blockAt(_number: number): Promise<BlockRef | null> {
    throw new Error(
      "ton's watcher scale is a transaction timestamp, not a block height; reorg detection " +
        'is off for this chain because a committed TON block is final',
    );
  }

  async get<T>(path: string, params: Readonly<Record<string, string | number>>): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    const url = `${this.config.apiUrl.replace(/\/$/, '')}/${path}${query.size > 0 ? `?${query}` : ''}`;

    const response = await fetch(url, {
      headers: this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {},
    });
    if (!response.ok) {
      /**
       * The status, and the path, and nothing from the body.
       *
       * 429 is the one that will happen: the anonymous rate limit is about one request a
       * second, and a poll over several wallets is more than that. The loop's backoff is the
       * right response, so this throws and says which call was refused.
       */
      throw new Error(`ton api ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
