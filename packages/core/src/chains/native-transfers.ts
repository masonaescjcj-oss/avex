import type { Asset, ChainId, IncomingPayment } from '../types.js';

/**
 * Finding payments in a chain's own coin — BNB, ETH, POL, TRX — which emit no event.
 *
 * Every other kind of payment this system detects is an ERC-20 style `Transfer` log, and a
 * log can be filtered: one `eth_getLogs` covers five hundred blocks and every address at
 * once. A transfer of the chain's own coin emits nothing. It is a field on the transaction,
 * so the only way to see it is to read the transactions — and a block of BNB Chain is a
 * quarter of a megabyte, so reading every block of a five-hundred-block window is fifty
 * megabytes a poll and out of the question.
 *
 * Which is why native assets were skipped by both adapters, with a comment saying it needed
 * "trace or balance polling". That was true and it was also a hole: BNB, ETH, POL and TRX are
 * approved and listed, so a merchant could enable BNB, a customer could pay in BNB, the money
 * would arrive in the merchant's wallet, and nothing in the system would ever notice. The
 * payer's transfer confirmed; the merchant's invoice sat unpaid.
 *
 * ## Cheap question first, expensive question only when it says yes
 *
 * A merchant's own wallet is quiet. Its balance changes when somebody pays, and at no other
 * time. So each poll asks the cheap question — what is the balance of each watched wallet? —
 * one small call per wallet, batched into a single request. Only when a balance has gone *up*
 * does it ask the expensive one, and then only over the blocks of that poll: read those
 * blocks' transactions and find the ones addressed to that wallet.
 *
 * In steady state that is a handful of bytes per poll. When somebody actually pays, it is a
 * few megabytes, once. The expensive path runs on the polls where there is something to find.
 *
 * ## The baseline, and what a restart costs
 *
 * The comparison needs a previous balance, and it is held in memory rather than fetched,
 * because fetching it means `eth_getBalance` at an old block and public nodes answer that with
 * "archive requests require a personal token". So the first poll after a start records the
 * balance and credits nothing — which is correct, because a wallet is watched from the moment
 * an invoice is opened on it, and the invoice always precedes the payment.
 *
 * What that costs is a native payment that lands during a restart: the new baseline already
 * includes it, so nothing sees it arrive. `install.sh --credit-tx <chain> <hash>` credits it
 * by hand. The same remedy the token path has when a node will not serve old logs.
 *
 * ## Confirming it, without a receipt
 *
 * A receipt says whether a transaction reverted, and asking for one is the obvious check.
 * Public endpoints do not all serve them: publicnode answers `eth_getTransactionReceipt` with
 * HTTP 403 outright, for a transaction three blocks old, batched or not.
 *
 * So the balance is the confirmation. The probe already knows how much the wallet gained; the
 * blocks say which transactions were addressed to it. When those add up to exactly the gain,
 * every one of them moved its money and nothing else did — which is a stronger statement than
 * a receipt's status flag, and it costs no request at all. When they do not add up, a receipt
 * decides; and where receipts are refused and the sums disagree, nothing is credited and the
 * difference is reported, because crediting on a guess is the one thing not to do here.
 *
 * ## What this cannot see
 *
 * A transfer made *by a contract* rather than by a transaction — an exchange paying out
 * through a batching contract, say. The value moves in an internal call, which appears in no
 * transaction's `to` and in no log, and only a tracing API would show it. When a balance rises
 * with no transaction to account for it, that is said out loud rather than passed over: the
 * money is in the wallet, and an operator can credit it by hash.
 */

/** Enough of a JSON-RPC endpoint to ask these questions. */
export interface NativeRpcConfig {
  readonly url: string;
  readonly chain: ChainId;
  /**
   * Sub-requests per HTTP request. Every chain here accepts a JSON-RPC array; a provider that
   * does not is handled by setting this to one, which sends each call on its own.
   */
  readonly maxBatch?: number | undefined;
}

export interface NativeScanRequest {
  /** The chain's own coin, from the catalogue, so decimals and symbol are the merchant's. */
  readonly asset: Asset;
  /** Every wallet of ours on this chain, in the form the address book stores. */
  readonly watched: readonly string[];
  /** The window this poll covers, in blocks. */
  readonly from: number;
  readonly to: number;
  /** The chain's head, for the confirmation count. */
  readonly head: number;
}

export interface NativeScannerConfig {
  readonly rpc: NativeRpcConfig;
  /** A stored address in the form the RPC speaks: lower-case hex, `0x…`. */
  readonly toRpcHex: (stored: string) => string | null;
  /** An RPC-reported address in the form the address book stores. */
  readonly toStored: (hex: string) => string;
  /**
   * Blocks read in one attribution scan.
   *
   * Only reached when a balance moved, so this is a bound on the cost of a real payment
   * rather than of a quiet poll. Sixty-four blocks is about three minutes of BNB Chain and
   * around twenty megabytes; a window wider than this leaves a gap, which is reported.
   */
  readonly maxBlocksPerScan?: number | undefined;
  /**
   * Wallets probed in one poll.
   *
   * A pooled chain has at most a hundred of a merchant's wallets, which is a single batched
   * request. A forwarder chain has one address per invoice and could have thousands, and
   * probing those is not a thing to do every five seconds — so past this count the native
   * pass says so and stops. Invoice creation refuses a native invoice on a forwarder address
   * for the same reason, so the two ends agree.
   */
  readonly maxAddresses?: number | undefined;
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * The transfer index a native payment is recorded at.
 *
 * The payment sink's identity is the transaction plus this number, and for a token it is the
 * log's index within the transaction. A native transfer has no logs, so nothing would collide
 * at zero today — but a contract call that both sends us value and emits a `Transfer` to us
 * would, and those are two payments. Well clear of any real log index instead.
 */
export const NATIVE_TRANSFER_INDEX = 1_000_000;

const DEFAULT_MAX_BLOCKS = 64;
const DEFAULT_MAX_ADDRESSES = 200;
const DEFAULT_MAX_BATCH = 10;

interface RpcTransaction {
  readonly hash?: string;
  readonly from?: string;
  readonly to?: string | null;
  readonly value?: string;
  readonly blockNumber?: string;
}

interface RpcBlock {
  readonly transactions?: readonly RpcTransaction[];
}

interface RpcReceipt {
  /**
   * Absent on TRON for a plain transfer, which is why this is not simply compared to `0x1`:
   * TRON's Ethereum-compatible RPC answers a `TransferContract` receipt without a status, and
   * requiring one would refuse every TRX payment.
   */
  readonly status?: string;
}

export class NativeTransferScanner {
  /**
   * The balance each wallet had when it was last looked at, and the block it was read at.
   *
   * The block matters: a delta can only be attributed to a window when the baseline sits
   * exactly one block below it. Otherwise the gain covers blocks this poll is not reading,
   * and the sums are not expected to agree.
   */
  private readonly balances = new Map<string, { readonly amount: bigint; readonly atBlock: number }>();

  /** Wallets a baseline has been taken for, so the first poll is announced once and not again. */
  private readonly baselined = new Set<string>();

  private rpcId = 0;

  /**
   * Set once an endpoint refuses receipts, so the poll stops asking.
   *
   * publicnode answers `eth_getTransactionReceipt` with a 403. Asking every poll would be a
   * refused request per payment for the life of the process.
   */
  private receiptsRefused = false;

  constructor(private readonly config: NativeScannerConfig) {}

  async scan(request: NativeScanRequest): Promise<readonly IncomingPayment[]> {
    const maxAddresses = this.config.maxAddresses ?? DEFAULT_MAX_ADDRESSES;
    if (request.watched.length === 0) return [];
    if (request.watched.length > maxAddresses) {
      this.warn(
        `${request.watched.length} addresses to watch for ${request.asset.symbol}, over the ` +
          `${maxAddresses} a balance probe is meant for. Native payments are not being ` +
          'detected on this chain; they are only supported into a merchant’s own wallet.',
      );
      return [];
    }

    /** Stored form, keyed by the lower-case hex the RPC will report. */
    const byHex = new Map<string, string>();
    for (const stored of request.watched) {
      const hex = this.config.toRpcHex(stored);
      // An unparseable row is skipped rather than fatal: one typo must not stop the chain.
      if (hex === null) continue;
      byHex.set(hex.toLowerCase(), stored);
    }
    if (byHex.size === 0) return [];

    const addresses = [...byHex.keys()];
    const at = `0x${request.to.toString(16)}`;
    const balances = (await this.batch(
      addresses.map((address) => ({ method: 'eth_getBalance', params: [address, at] })),
    )) as string[];

    /**
     * The new balances, held aside rather than written.
     *
     * Committed only once attribution has finished, because a baseline that advanced while
     * the expensive half threw — a refused request, a node that dropped the connection —
     * would already include the payment, and the retry would find nothing to explain. That is
     * a payment lost to a transient error, which is precisely the class of bug this whole
     * module was written to remove.
     */
    const measured = new Map<string, bigint>();
    const risen = new Map<string, bigint>();

    for (const [index, address] of addresses.entries()) {
      const now = BigInt(balances[index] ?? '0x0');
      measured.set(address, now);
      const before = this.balances.get(address);

      if (before === undefined) {
        if (!this.baselined.has(address)) {
          this.baselined.add(address);
          this.warn(
            `first look at ${byHex.get(address)}: its ${request.asset.symbol} balance is the ` +
              'baseline, so a payment that landed before now is not detected. Credit one by ' +
              'hash with --credit-tx if a payer reports it.',
          );
        }
        continue;
      }
      if (now > before.amount) risen.set(address, now - before.amount);
    }

    if (risen.size === 0) {
      this.commit(measured, request.to);
      return [];
    }

    /** Whether each rise is measured over exactly the blocks this poll will read. */
    const aligned = new Map<string, boolean>();
    for (const address of risen.keys()) {
      aligned.set(address, this.balances.get(address)?.atBlock === request.from - 1);
    }

    /**
     * The blocks to read: this poll's window, from the newest back, bounded.
     *
     * A window wider than the bound leaves its older end unread, which is a gap and is said
     * so. It happens after a long outage, where the token path has the same problem for the
     * same reason — a public node will not serve either old logs or old state.
     */
    const maxBlocks = this.config.maxBlocksPerScan ?? DEFAULT_MAX_BLOCKS;
    const scanFrom = Math.max(request.from, request.to - maxBlocks + 1);
    if (scanFrom > request.from) {
      this.warn(
        `a ${request.asset.symbol} balance rose over blocks ${request.from}–${request.to}, ` +
          `which is wider than the ${maxBlocks} blocks one scan reads; only ${scanFrom}–` +
          `${request.to} was read. Anything older needs --credit-tx.`,
      );
    }

    const heights: number[] = [];
    for (let height = scanFrom; height <= request.to; height++) heights.push(height);

    const blocks = (await this.batch(
      heights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, true],
      })),
    )) as (RpcBlock | null)[];

    const risenSet = new Set(risen.keys());
    const candidates: RpcTransaction[] = [];
    for (const block of blocks) {
      for (const transaction of block?.transactions ?? []) {
        if (transaction.to === null || transaction.to === undefined) continue;
        if (!risenSet.has(transaction.to.toLowerCase())) continue;
        if (transaction.value === undefined || BigInt(transaction.value) <= 0n) continue;
        if (transaction.hash === undefined) continue;
        candidates.push(transaction);
      }
    }

    if (candidates.length === 0) {
      /**
       * The balance moved and no transaction accounts for it: a contract sent it in an
       * internal call, which appears in no transaction's `to` and in no log.
       *
       * Said out loud because the money is really there. Silence here is the failure this
       * whole module exists to remove, so it is not reintroduced at the last step.
       */
      this.warn(
        `${[...risen.keys()].map((address) => byHex.get(address)).join(', ')}: the ` +
          `${request.asset.symbol} balance rose over blocks ${scanFrom}–${request.to} and no ` +
          'transaction in them is addressed to it. A contract sent it, which only a tracing ' +
          'API would show. Credit it by hash with --credit-tx.',
      );
      this.commit(measured, request.to);
      return [];
    }

    /**
     * Receipts, for what is already a candidate — a call per real payment, and skipped
     * entirely on an endpoint that has refused them once.
     */
    let receipts: (RpcReceipt | null)[] | null = null;
    if (!this.receiptsRefused) {
      try {
        receipts = (await this.batch(
          candidates.map((transaction) => ({
            method: 'eth_getTransactionReceipt',
            params: [transaction.hash],
          })),
        )) as (RpcReceipt | null)[];
      } catch (error) {
        this.receiptsRefused = true;
        this.warn(
          `this endpoint will not serve transaction receipts ` +
            `(${error instanceof Error ? error.message : String(error)}). ` +
            `${request.asset.symbol} payments are confirmed against the balance they moved ` +
            'instead, which is stronger, and are refused when the two do not agree.',
        );
      }
    }

    /**
     * Without receipts: the transfers must account for the whole rise, exactly.
     *
     * Then every one of them moved its money and nothing else did. If they do not add up, the
     * difference is a reverted transfer, gas the wallet itself spent, or a contract's internal
     * call — and none of those can be told apart from here, so nothing is credited.
     *
     * Only when the rise was measured over exactly the blocks read, too: a window narrowed by
     * the scan bound covers less than the delta does, and the sums are not meant to agree.
     */
    const accountedFor = new Map<string, bigint>();
    for (const transaction of candidates) {
      const address = transaction.to!.toLowerCase();
      accountedFor.set(address, (accountedFor.get(address) ?? 0n) + BigInt(transaction.value!));
    }

    const trusted = new Set<string>();
    if (receipts === null) {
      for (const [address, gain] of risen) {
        if (aligned.get(address) !== true) continue;
        if ((accountedFor.get(address) ?? 0n) === gain) trusted.add(address);
      }
      for (const address of risen.keys()) {
        if (trusted.has(address)) continue;
        this.warn(
          `${byHex.get(address)}: its ${request.asset.symbol} balance rose by ${risen.get(address)} ` +
            `and the transactions addressed to it in blocks ${scanFrom}–${request.to} account ` +
            `for ${accountedFor.get(address) ?? 0n}. Nothing is credited on a difference; ` +
            'credit by hash with --credit-tx.',
        );
      }
    }

    const payments: IncomingPayment[] = [];
    for (const [index, transaction] of candidates.entries()) {
      if (receipts === null) {
        if (!trusted.has(transaction.to!.toLowerCase())) continue;
      } else {
        const status = receipts[index]?.status;
        // A reverted transaction moved nothing. TRON reports no status for a plain transfer.
        if (status !== undefined && status !== '0x1') continue;
      }

      const blockNumber = Number(BigInt(transaction.blockNumber ?? '0x0'));
      payments.push({
        chain: this.config.rpc.chain,
        txHash: transaction.hash!,
        transferIndex: NATIVE_TRANSFER_INDEX,
        to: this.config.toStored(transaction.to!),
        ...(transaction.from === undefined ? {} : { from: this.config.toStored(transaction.from) }),
        asset: request.asset,
        amount: BigInt(transaction.value!),
        blockNumber,
        confirmations: request.head - blockNumber + 1,
      });
    }

    this.commit(measured, request.to);
    return payments;
  }

  /** Write the balances this poll read, now that nothing can throw before the next one. */
  private commit(measured: ReadonlyMap<string, bigint>, atBlock: number): void {
    for (const [address, amount] of measured) this.balances.set(address, { amount, atBlock });
  }

  private warn(message: string): void {
    this.config.warn?.(message);
  }

  /** Every call's result, in the order given, over as few HTTP requests as the endpoint allows. */
  private async batch(calls: readonly { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const size = Math.max(1, this.config.rpc.maxBatch ?? DEFAULT_MAX_BATCH);
    const results: unknown[] = [];
    for (let i = 0; i < calls.length; i += size) {
      results.push(...(await this.send(calls.slice(i, i + size))));
    }
    return results;
  }

  private async send(calls: readonly { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const ids = calls.map(() => ++this.rpcId);
    const response = await fetch(this.config.rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        calls.map((call, index) => ({
          jsonrpc: '2.0',
          id: ids[index],
          method: call.method,
          params: call.params,
        })),
      ),
    });
    if (!response.ok) {
      throw new Error(
        `${this.config.rpc.chain} rpc ${calls.map((call) => call.method).join(', ')}: ` +
          `HTTP ${response.status}`,
      );
    }

    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) {
      const error = (parsed as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(
        `${this.config.rpc.chain} rpc: expected ${calls.length} batched responses, got one ` +
          `object${error === undefined ? '. Does this endpoint accept batches?' : `: ${error}`}`,
      );
    }

    const byId = new Map<number, { id?: number; result?: unknown; error?: { message?: string } }>();
    for (const entry of parsed as { id?: number }[]) {
      if (typeof entry?.id === 'number') byId.set(entry.id, entry);
    }

    return calls.map((call, index) => {
      const entry = byId.get(ids[index]!);
      if (entry === undefined) throw new Error(`${this.config.rpc.chain} rpc ${call.method}: no response`);
      if (entry.error) {
        throw new Error(`${this.config.rpc.chain} rpc ${call.method}: ${entry.error.message}`);
      }
      // `null` is a real answer: a block not yet there, a receipt the node has pruned.
      if (!('result' in entry)) throw new Error(`${this.config.rpc.chain} rpc ${call.method}: no result`);
      return entry.result;
    });
  }
}
