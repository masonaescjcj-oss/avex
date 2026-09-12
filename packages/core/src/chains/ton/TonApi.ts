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
  /**
   * Smallest gap between two requests. Defaults by whether a key is configured.
   *
   * Set rather than guessed because the two regimes are an order of magnitude apart, and
   * getting it wrong in either direction is costly: too fast and every poll is refused, too
   * slow and a merchant with ten wallets waits minutes to be told they were paid.
   */
  readonly minIntervalMs?: number | undefined;
  /** How many times a request refused for rate is tried again before the poll fails. */
  readonly maxRetries?: number | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * One request a second, near enough, which is toncenter's anonymous allowance.
 *
 * Not a safety margin somebody chose to be careful: without it TON does not work at all on a
 * free endpoint. A single poll is three requests — the head, then the jetton transfers and
 * the plain transfers for each wallet — fired one after another as fast as they complete, so
 * the second and third are refused and the whole poll fails. A merchant watched TON payments
 * go unseen with `HTTP 429` in the log for exactly this reason.
 */
const ANONYMOUS_MIN_INTERVAL_MS = 1100;

/** With a key the allowance is many times a second; this leaves plenty of room under it. */
const KEYED_MIN_INTERVAL_MS = 110;

const DEFAULT_MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface MasterchainInfo {
  readonly last: {
    readonly seqno: number;
    readonly root_hash: string;
    /** A string in this response and a number in others, so both are handled. */
    readonly gen_utime: string | number;
  };
}

export class TonApi implements BlockSource {
  /**
   * The pacer: one promise chain every request waits its turn in.
   *
   * A queue rather than a token bucket because the requests are not independent — a poll
   * issues them in order and each result is needed before the next decision — so there is
   * nothing to gain from letting two run at once, and a queue cannot burst by construction.
   */
  private turn: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly config: TonApiConfig) {}

  private get minIntervalMs(): number {
    return (
      this.config.minIntervalMs ??
      (this.config.apiKey ? KEYED_MIN_INTERVAL_MS : ANONYMOUS_MIN_INTERVAL_MS)
    );
  }

  /** Run `work` no sooner than `minIntervalMs` after the last request finished. */
  private paced<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.turn.then(async () => {
      const waited = Date.now() - this.lastRequestAt;
      if (waited < this.minIntervalMs) await sleep(this.minIntervalMs - waited);
      try {
        return await work();
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
    // The queue must not break on a failed request, and must not report that failure twice.
    this.turn = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

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

    const headers = this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {};
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;

    for (let attempt = 0; ; attempt++) {
      const response = await this.paced(() => fetch(url, { headers }));
      if (response.ok) return (await response.json()) as T;

      /**
       * Refused for rate: waited out and tried again, rather than failing the poll.
       *
       * The pacing above is what should keep this from happening, but it cannot know what
       * else shares the allowance — another process, another service on the same key, or the
       * anonymous pool being busy. Retrying here turns a burst into a slow poll; failing
       * would turn it into a payment nobody sees until the next round.
       */
      if (response.status === 429 && attempt < maxRetries) {
        await discard(response);
        const wait = retryAfterMs(response) ?? this.minIntervalMs * 2 ** (attempt + 1);
        this.config.warn?.(
          `ton api ${path}: rate limited, waiting ${wait}ms (attempt ${attempt + 1} of ${maxRetries})`,
        );
        await sleep(wait);
        continue;
      }

      /**
       * The status, and the path, and nothing from the body.
       *
       * Reached when the retries are spent or the refusal is something else. Whatever the
       * poll had gathered is thrown away with it and the cursor does not move, so nothing is
       * lost — the same window is read again next round.
       */
      await discard(response);
      throw new Error(`ton api ${path}: HTTP ${response.status}`);
    }
  }
}

/** `Retry-After`, in milliseconds, when the server said one. Seconds or an HTTP date. */
function retryAfterMs(response: Response): number | null {
  // Guarded, because a refusal can arrive through anything shaped like a response.
  const header = response.headers?.get('retry-after') ?? null;
  if (header === null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);

  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - Date.now(), 0), 60_000);
}

/**
 * Read and drop a body we are not going to use.
 *
 * A response whose body is never consumed holds its connection open in Node's HTTP client,
 * and a retry loop that leaks one per attempt is a slow leak on the one path that runs often.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer?.();
  } catch {
    // A body that cannot be read is a body already gone, which is the outcome wanted.
  }
}
