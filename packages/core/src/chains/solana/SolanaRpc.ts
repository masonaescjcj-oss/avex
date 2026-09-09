import type { BlockRef, BlockSource } from '../../watch/Watcher.js';

/**
 * Solana's JSON-RPC, and the watcher's view of the chain's head.
 *
 * Two jobs in one class because they are the same connection. The EVM chains get this from
 * `JsonRpcCaller`, which speaks `eth_*` and is handed the same URL the adapter polls with;
 * Solana speaks a different vocabulary entirely — `getSlot`, `getSignaturesForAddress`,
 * `getTransaction` — so it needs its own, and a second URL in configuration to go with it.
 * Putting a Solana endpoint in `EVM_RPC_URLS` would give the gas oracle and the contract
 * prober an endpoint that answers every one of their calls with "method not found".
 *
 * ## Slots, not blocks
 *
 * Everything above this interface counts in blocks. Solana counts in slots, and not every
 * slot has a block: a leader that misses its turn leaves a gap, so slot numbers advance
 * faster than blocks do. The watcher never needs the difference — it needs a monotonic
 * number to keep a cursor in and to compare a transfer's position against — so a slot is
 * what it is given, and `blockAt` returning null for a skipped slot is the honest answer.
 *
 * ## Commitment is the finality
 *
 * Every call here asks for `finalized`, which on Solana means rooted by a supermajority of
 * stake and never rolled back. That is a stronger guarantee than "twelve blocks deep" on an
 * EVM chain, and it is why the chain registry says this chain has no reorgs: the watcher's
 * rewind machinery is switched off for it rather than being fed slot hashes it would never
 * find a disagreement in. Asking at `confirmed` instead would be the bug that reorg
 * machinery exists for.
 *
 * ## Batching
 *
 * A poll asks a handful of small questions — the signatures for each of a merchant's token
 * accounts — and one HTTP round trip for all of them is the difference between a poll that
 * fits inside a public endpoint's rate limit and one that does not. JSON-RPC batching is a
 * request body that is an array; responses may come back in any order, so they are matched
 * by id rather than by position, which is the mistake that silently pairs one account's
 * signatures with another account's address.
 */

export interface SolanaRpcConfig {
  readonly url: string;
  /**
   * Sub-requests per HTTP request.
   *
   * Ten is what the public endpoint accepts. A provider that refuses batches altogether is
   * handled by setting this to one, which sends each call on its own.
   */
  readonly maxBatch?: number | undefined;
}

interface RpcCall {
  readonly method: string;
  readonly params: unknown[];
}

interface RpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
}

/** What `getLatestBlockhash` answers with, which is a hash and the slot it was read at. */
interface LatestBlockhash {
  readonly context: { readonly slot: number };
  readonly value: { readonly blockhash: string };
}

interface BlockHeader {
  readonly blockhash: string;
  readonly parentSlot?: number;
}

export class SolanaRpc implements BlockSource {
  private nextId = 0;
  private readonly maxBatch: number;

  constructor(private readonly config: SolanaRpcConfig) {
    this.maxBatch = Math.max(1, config.maxBatch ?? 10);
  }

  /** The newest finalized slot. */
  async slot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: 'finalized' }]);
  }

  /**
   * The head, as the watcher wants it: a number and a hash.
   *
   * `getSlot` for the number and `getLatestBlockhash` for the hash, in one round trip,
   * rather than trusting `getLatestBlockhash`'s own context slot — providers disagree about
   * which commitment that context reflects, and a head number that is quietly ahead of
   * finality would put the cursor past transfers that had not been finalized yet.
   */
  async head(): Promise<BlockRef> {
    const [slot, latest] = await this.batch([
      { method: 'getSlot', params: [{ commitment: 'finalized' }] },
      { method: 'getLatestBlockhash', params: [{ commitment: 'finalized' }] },
    ]);
    return {
      number: slot as number,
      hash: (latest as LatestBlockhash).value.blockhash,
    };
  }

  /**
   * The block at a slot, or null where the leader missed its turn.
   *
   * Not called while the chain registry says this chain has no reorgs — the watcher's
   * `blockMemory` is zero for it, so nothing is remembered and nothing is compared. Written
   * correctly all the same, because the alternative is a method that lies if the reorg
   * machinery is ever switched on.
   */
  async blockAt(number: number): Promise<BlockRef | null> {
    const header = await this.call<BlockHeader | null>('getBlock', [
      number,
      {
        commitment: 'finalized',
        transactionDetails: 'none',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (header === null) return null;
    return { number, hash: header.blockhash };
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const [result] = await this.batch([{ method, params }]);
    return result as T;
  }

  /** Every call's result, in the order the calls were given. */
  async batch(calls: readonly RpcCall[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (let i = 0; i < calls.length; i += this.maxBatch) {
      results.push(...(await this.send(calls.slice(i, i + this.maxBatch))));
    }
    return results;
  }

  private async send(calls: readonly RpcCall[]): Promise<unknown[]> {
    const ids = calls.map(() => ++this.nextId);
    const body = calls.map((call, index) => ({
      jsonrpc: '2.0',
      id: ids[index],
      method: call.method,
      params: call.params,
    }));

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `solana rpc ${calls.map((call) => call.method).join(', ')}: HTTP ${response.status}`,
      );
    }

    const parsed: unknown = await response.json();
    /**
     * A single object where an array was asked for is an endpoint that does not batch.
     *
     * Said as itself rather than as "cannot read property of undefined", because the fix is
     * a configuration one — `maxBatch: 1` — and nothing about the message would otherwise
     * point at it.
     */
    if (!Array.isArray(parsed)) {
      const error = (parsed as RpcResponse | null)?.error?.message;
      throw new Error(
        `solana rpc: expected ${calls.length} batched responses, got one object` +
          (error === undefined ? '. Does this endpoint accept batches?' : `: ${error}`),
      );
    }

    const byId = new Map<number, RpcResponse>();
    for (const entry of parsed as RpcResponse[]) {
      if (typeof entry?.id === 'number') byId.set(entry.id, entry);
    }

    return calls.map((call, index) => {
      const entry = byId.get(ids[index]!);
      if (entry === undefined) throw new Error(`solana rpc ${call.method}: no response`);
      if (entry.error) throw new Error(`solana rpc ${call.method}: ${entry.error.message}`);
      // `null` is a real answer — a skipped slot, a signature the node has pruned — so only
      // an absent field is a fault.
      if (!('result' in entry)) throw new Error(`solana rpc ${call.method}: no result`);
      return entry.result;
    });
  }
}
