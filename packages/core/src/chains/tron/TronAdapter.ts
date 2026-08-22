import { keccak256, toHex } from '../../crypto/keccak256.js';
import type { Asset, ChainId, GasSnapshot, IncomingPayment } from '../../types.js';
import { noSettlementNeeded } from '../ChainAdapter.js';
import type {
  ChainAdapter,
  DeriveInput,
  DepositTarget,
  PollCursor,
  PollResult,
  SettlementRequest,
  SettlementResult,
} from '../ChainAdapter.js';
import { isTronAddress, normalizeTronAddress, tronAddressToEvmHex } from './address.js';

/**
 * TRON, for detecting payments. It sends nothing, and that is the design rather than a gap.
 *
 * The deposit addresses on this chain are the merchant's own — see `addressModel: 'pooled'` in
 * the chain registry — so the payer's transfer lands in their wallet directly and there is no
 * sweep to perform, no key to hold, and no settlement transaction to build. Which removes the
 * two hardest parts of a TRON integration at a stroke: no protobuf transaction encoding, and no
 * signing. What is left is watching.
 *
 * ## Why this is JSON-RPC and not TronGrid's own API
 *
 * TRON nodes expose an Ethereum-compatible JSON-RPC — `eth_blockNumber`, `eth_getLogs`,
 * `eth_getBlockByNumber` — and TRC-20 is ERC-20 with a different address encoding, so a
 * `Transfer` event is the same event with the same topic. Polling it that way means this adapter
 * shares its shape, its reorg handling and its block source with the EVM one, rather than being
 * a second implementation of the same logic against TronGrid's timestamp-paged event endpoint.
 * The alternative was a cursor made of timestamps, which cannot express "rescan from block N"
 * and so cannot survive a reorg honestly.
 *
 * ## The one thing that is genuinely different
 *
 * Addresses. A TRON address is 21 bytes — `0x41` then the same twenty an EVM address is — and it
 * is written Base58Check everywhere a human or a merchant sees it. The JSON-RPC speaks the
 * 20-byte hex form. So every address crosses that boundary twice per poll: the accepted
 * contracts go out as hex in the filter, and the recipients come back as hex and are converted
 * to Base58Check before anything compares them. Getting that wrong does not fail loudly — it
 * finds no payments at all, on the chain expected to carry the most volume, and looks exactly
 * like nobody having paid.
 */

export interface TronAdapterConfig {
  readonly chain: ChainId;
  /** A TRON JSON-RPC endpoint. TronGrid serves one at `/jsonrpc`. */
  readonly rpcUrl: string;
  /**
   * TRC-20 contracts we watch, with their addresses in any form this repository's codec
   * accepts. Anything not in here is ignored: deploying a token called USDT on TRON costs a
   * few cents, and auto-crediting an unknown contract would make one of them revenue.
   */
  readonly acceptedAssets: readonly Asset[];
  /** Blocks scanned per poll. TRON produces a block every three seconds. */
  readonly pollRange: number;
}

/** Where a transfer's recipient is looked up, to decide whether it is ours. */
export interface TronAddressBook {
  lookup(address: string): Promise<string | null>;
}

/** Native price, for the gas model. Never consulted during a poll. */
export interface TronPriceOracle {
  nativePriceUsd(): Promise<number>;
}

const TRANSFER_TOPIC = toHex(
  keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')),
);

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export class TronAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly addressModel = 'pooled' as const;
  private rpcId = 0;

  constructor(
    private readonly config: TronAdapterConfig,
    private readonly oracle: TronPriceOracle,
    private readonly addressBook: TronAddressBook,
  ) {
    this.chain = config.chain;
  }

  /**
   * Refused, because the address is not derivable on this chain.
   *
   * A pooled deposit address is a row in the merchant's wallet pool, chosen against the invoices
   * currently open on it — a database read inside the transaction that writes the invoice.
   * `WalletPoolService.allocate` answers instead. Throwing here rather than returning something
   * plausible: a caller that reached this line has skipped the allocation, and an address it
   * invented would be one no merchant owns.
   */
  async deriveDepositTarget(_input: DeriveInput): Promise<DepositTarget> {
    throw new Error(
      'tron deposit addresses come from the merchant wallet pool, not from derivation',
    );
  }

  /**
   * Zero, and honestly so.
   *
   * Nothing here settles, so there is no cost to estimate. The chain registry says the same
   * thing with `settlement: { kind: 'direct' }`, and `FeePolicy` never asks for an energy price.
   * The native price is still reported because the snapshot's shape requires it and because a
   * TRX figure is the one thing a reader of a gas snapshot expects to find.
   */
  async probeGas(): Promise<GasSnapshot> {
    return {
      chain: this.chain,
      nativePriceUsd: await this.oracle.nativePriceUsd(),
      observedAt: Date.now(),
    };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const head = Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));
    const from = cursor === null ? head : Number(cursor) + 1;
    if (from > head) return { payments: [], cursor: String(head) };

    const to = Math.min(head, from + this.config.pollRange - 1);

    /**
     * The watched contracts, keyed by the hex form the node will report.
     *
     * Keyed on hex rather than Base58Check because that is what comes back in a log, and
     * converting every log's address for a lookup would be a codec call per log rather than per
     * contract. The asset kept in the map is the original, so what is credited carries the
     * symbol and decimals from the catalogue rather than anything derived here.
     */
    const byContract = new Map<string, Asset>();
    for (const asset of this.config.acceptedAssets) {
      if (asset.kind === 'native') continue;
      if (asset.contract === undefined) continue;
      /**
       * An unparseable contract address is skipped, not fatal.
       *
       * The catalogue is partly merchant-submitted, and one bad row must not stop the chain
       * being watched — that would turn a data-entry mistake into every other merchant's
       * payments going unnoticed.
       */
      if (!isTronAddress(asset.contract)) continue;
      byContract.set(tronAddressToEvmHex(asset.contract).toLowerCase(), asset);
    }
    if (byContract.size === 0) return { payments: [], cursor: String(to) };

    const logs = await this.rpc<RpcLog[]>('eth_getLogs', [
      {
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        address: [...byContract.keys()],
        topics: [TRANSFER_TOPIC],
      },
    ]);

    const payments: IncomingPayment[] = [];
    for (const log of logs) {
      const asset = byContract.get(log.address.toLowerCase());
      // A log from a contract not in the map is dropped rather than attributed to a guess.
      if (asset === undefined) continue;

      const recipientTopic = log.topics[2];
      if (recipientTopic === undefined) continue;

      /**
       * The recipient, as Base58Check.
       *
       * Topics pad an address to 32 bytes, so the twenty that matter are the last twenty. The
       * conversion is what makes this comparable to what the merchant registered and what the
       * invoice stored — and it is why `payments.to_address` on this chain reads as a `T…`
       * address in the admin panel rather than as hex nobody can match to a wallet.
       */
      const recipient = normalizeTronAddress(`0x${recipientTopic.slice(26)}`);
      if ((await this.addressBook.lookup(recipient)) === null) continue;

      const blockNumber = Number(BigInt(log.blockNumber));
      payments.push({
        chain: this.chain,
        txHash: log.transactionHash,
        transferIndex: Number(BigInt(log.logIndex)),
        to: recipient,
        asset,
        amount: BigInt(log.data),
        blockNumber,
        confirmations: head - blockNumber + 1,
      });
    }

    return { payments, cursor: String(to) };
  }

  /**
   * Nothing to settle, ever.
   *
   * The payer paid the merchant's own wallet. `noSettlementNeeded` is the same answer TON gives,
   * for the same reason, and it returns an empty array rather than throwing — a settlement queue
   * that asked would be told "already done", which is true.
   */
  async prepareSettlement(_batch: readonly SettlementRequest[]): Promise<null> {
    return noSettlementNeeded();
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    if (!response.ok) {
      throw new Error(`${this.chain} rpc ${method}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${this.chain} rpc ${method}: ${body.error.message}`);
    if (body.result === undefined) throw new Error(`${this.chain} rpc ${method}: no result`);
    return body.result;
  }
}
