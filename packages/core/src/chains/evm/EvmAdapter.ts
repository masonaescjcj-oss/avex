import { concatBytes, fromHex, keccak256, toHex } from '../../crypto/keccak256.js';
import type {
  Asset,
  ChainId,
  GasSnapshot,
  IncomingPayment,
} from '../../types.js';
import type {
  ChainAdapter,
  DepositTarget,
  DeriveInput,
  FeeSplit,
  PollCursor,
  PollResult,
  SettlementCall,
  SettlementRequest,
  SettlementResult,
} from '../ChainAdapter.js';
import { chainConfig } from '../registry.js';
import {
  RECIPIENTS_PER_FILTER,
  addressTopicOrNull,
  inBatches,
  isLogQueryLimitError,
  narrowedRange,
} from '../transfer-topics.js';
import {
  NO_FEE,
  invoiceSalt,
  predictForwarder,
  toChecksumAddress,
  type Create2Config,
  type ForwarderFee,
} from './create2.js';

/** USD price of a chain's native token. Injected so the oracle stays swappable. */
export interface PriceOracle {
  nativePriceUsd(chain: ChainId): Promise<number>;
}

/**
 * Signs and broadcasts settlement transactions.
 *
 * Deliberately an interface: key material belongs in a KMS or hardware signer,
 * not in this repository. The gateway is non-custodial for payer funds, but it
 * still needs a funded account to pay gas for settlement batches, and that key
 * is the one genuinely sensitive secret in the system.
 */
/** Maps a deposit address back to the invoice that owns it. */
export interface AddressBook {
  lookup(address: string): Promise<string | null>;
  /**
   * Every address on this chain a transfer to which would be ours.
   *
   * The poll asks the node for transfers *to these* rather than for every transfer of the
   * tokens we accept: the second question is one about the whole chain, and on a busy one a
   * public node refuses to answer it at all.
   *
   * So this list decides what the watcher can see, and it is deliberately every deposit
   * address ever derived on the chain rather than only the ones with an invoice still open.
   * Money that arrives late is money that arrived — the payer sent it to an address derived
   * for their invoice and it cannot be anywhere else — and a filter that had forgotten the
   * address would leave a real transfer credited to nothing.
   */
  watched(): Promise<readonly string[]>;
}

export interface EvmAdapterConfig {
  readonly chain: ChainId;
  readonly rpcUrl: string;
  /**
   * The forwarder factory and its logic contract, for deriving per-invoice addresses.
   *
   * Optional, because a chain can be worth watching with no contract of ours on it at all:
   * a merchant's own wallets take payments there, matched by amount, and those addresses
   * come from the address book rather than from CREATE2. Without this, `deriveDepositTarget`
   * and `settleBatch` refuse — there is nothing to derive from and nothing to settle to — and
   * the adapter is a watcher and nothing else.
   */
  readonly create2?: Create2Config | undefined;
  /** Token contracts we watch. Anything else is ignored — never auto-credit
   *  an unknown contract, or a worthless clone named "USDT" becomes revenue. */
  readonly acceptedAssets: readonly Asset[];
  /** Blocks scanned per poll. Keep under the RPC provider's getLogs range cap. */
  readonly pollRange: number;
  /**
   * Blocks held back from the chain's head before a range is scanned.
   *
   * A transfer is handed to the sink once, with however many confirmations it has when its
   * block is scanned. Scanning right up to the head means seeing nearly every transfer with
   * one confirmation, and a sink that wants fifteen has to defer it and be shown it again.
   * Staying this many blocks behind the head means a transfer is first seen with at least
   * this many confirmations, so the ordinary payment is final the first time the sink sees
   * it. Zero scans to the head. Set from the chain's standard confirmation count.
   */
  readonly confirmationLag?: number | undefined;
}

const TRANSFER_TOPIC = toHex(
  keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')),
);

const SETTLE_BATCH_SELECTOR = toHex(
  keccak256(new TextEncoder().encode('settleBatch((bytes32,address,address,uint16,address)[])')),
).slice(0, 10);

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/**
 * Adapter for Ethereum, Polygon and BNB Smart Chain.
 *
 * The three share one implementation because they differ only in RPC endpoint,
 * native token price and confirmation depth — all configuration, not code. That
 * is the payoff of the ChainAdapter seam: the third EVM chain costs an entry in
 * the registry rather than a new integration.
 */
export class EvmAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly addressModel = 'unique' as const;

  private rpcId = 0;
  /**
   * How many blocks the next poll asks for.
   *
   * Starts at the configured range and halves each time a node refuses a log query for its
   * size, then grows back once queries succeed. A fixed range met a public node's limit after
   * every restart: the gap the restart left was hundreds of blocks, the node refused a query
   * that wide, and the watcher retried the same width for as long as it was left running.
   */
  private rangeCap: number;

  constructor(
    private readonly config: EvmAdapterConfig,
    private readonly oracle: PriceOracle,
    private readonly addressBook: AddressBook,
  ) {
    this.rangeCap = config.pollRange;
    this.chain = config.chain;
  }

  async deriveDepositTarget(input: DeriveInput): Promise<DepositTarget> {
    if (!this.config.create2) {
      throw new Error(
        `${this.chain} has no forwarder factory configured; only the merchants' own wallets ` +
          'take payments on it',
      );
    }
    return {
      address: predictForwarder(
        this.config.create2,
        input.invoiceId,
        toChecksumAddress(input.payoutAddress),
        feeOrNone(input.fee),
      ),
    };
  }

  async probeGas(): Promise<GasSnapshot> {
    const [baseFeeHex, priorityHex, nativePriceUsd] = await Promise.all([
      this.rpc<string>('eth_gasPrice', []),
      this.rpc<string>('eth_maxPriorityFeePerGas', []).catch(() => '0x0'),
      this.oracle.nativePriceUsd(this.chain),
    ]);

    return {
      chain: this.chain,
      nativePriceUsd,
      feePerGasWei: BigInt(baseFeeHex) + BigInt(priorityHex),
      observedAt: Date.now(),
    };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const head = Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));
    /**
     * The newest block worth scanning: the head, less the lag.
     *
     * Nothing below `from` is ever returned as the cursor — a cursor that moved backwards
     * would rescan blocks already credited on every poll — so a fresh start with a lag simply
     * waits for the chain to move on.
     */
    const safeHead = head - Math.max(0, this.config.confirmationLag ?? 0);
    const from = cursor === null ? safeHead : Number(cursor) + 1;
    if (from > safeHead) return { payments: [], cursor: cursor ?? String(safeHead) };

    const to = Math.min(safeHead, from + this.rangeCap - 1);
    const payments: IncomingPayment[] = [];

    /**
     * One request for every token, not one request per token.
     *
     * `eth_getLogs` takes an array of addresses, and using it is the difference between a
     * poll that costs one call and a poll that costs as many calls as the catalogue holds.
     * Merchants can submit their own contracts, so that number grows without anybody
     * deciding to grow it — and a poll every few seconds multiplied by a few hundred tokens
     * is a rate limit, then a provider ban, then payments going unnoticed.
     *
     * Native assets are skipped: an incoming native transfer emits no log, so finding one
     * needs trace or balance polling rather than a filter.
     */
    const byContract = new Map<string, Asset>();
    for (const asset of this.config.acceptedAssets) {
      if (asset.kind === 'native') continue;
      if (asset.contract === undefined) continue;
      byContract.set(asset.contract.toLowerCase(), asset);
    }
    if (byContract.size === 0) return { payments: [], cursor: String(to) };

    /**
     * Our own addresses, as the third topic of `Transfer`.
     *
     * Nothing to watch means nothing to ask: the cursor still advances, because blocks with
     * no invoice of ours in them are blocks that have been looked at. Asking without this
     * filter — which is what this did — requests every transfer of every accepted token on
     * the chain, and BNB Chain answers "limit exceeded" instead of answering.
     */
    const recipients = (await this.addressBook.watched())
      .map((address) => addressTopicOrNull(address))
      .filter((topic): topic is string => topic !== null);
    if (recipients.length === 0) return { payments: [], cursor: String(to) };

    const logs: RpcLog[] = [];
    try {
      for (const batch of inBatches(recipients, RECIPIENTS_PER_FILTER)) {
        logs.push(
          ...(await this.rpc<RpcLog[]>('eth_getLogs', [
            {
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
              address: [...byContract.keys()],
              topics: [TRANSFER_TOPIC, null, batch],
            },
          ])),
        );
      }
    } catch (error) {
      /**
       * Refused for size: ask for less next time, and say so in the error the loop logs.
       *
       * Not retried here. The watcher's loop already backs off and polls again, and the
       * narrower range is what the next poll uses; retrying inside one poll would hide how
       * often this happens from the log that is supposed to show it.
       */
      if (isLogQueryLimitError(error) && this.rangeCap > narrowedRange(this.rangeCap)) {
        const before = this.rangeCap;
        this.rangeCap = narrowedRange(this.rangeCap);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — the node refused a ` +
            `${to - from + 1}-block query; narrowing from ${before} to ${this.rangeCap} blocks per poll`,
        );
      }
      throw error;
    }
    // A query that went through means the node can take this much; try a little more.
    if (this.rangeCap < this.config.pollRange) {
      this.rangeCap = Math.min(this.config.pollRange, this.rangeCap * 2);
    }

    for (const log of logs) {
      /**
       * Which token this was, from the emitting contract.
       *
       * With one filter per token the answer was implicit in which loop found the log. Now it
       * has to be looked up — and a log from a contract that is not in the map is dropped
       * rather than attributed to a guess, because attributing it would credit a merchant in
       * a currency nobody accepted.
       */
      const asset = byContract.get(log.address.toLowerCase());
      if (asset === undefined) continue;

      const recipientTopic = log.topics[2];
      if (recipientTopic === undefined) continue;

      // Topics pad addresses to 32 bytes; the address is the last 20.
      const recipient = toChecksumAddress(`0x${recipientTopic.slice(26)}`);
      if ((await this.addressBook.lookup(recipient)) === null) continue;
      // The sender is the second topic, padded the same way.
      const senderTopic = log.topics[1];
      const sender =
        senderTopic === undefined ? undefined : toChecksumAddress(`0x${senderTopic.slice(26)}`);

      const blockNumber = Number(BigInt(log.blockNumber));
      payments.push({
        chain: this.chain,
        txHash: log.transactionHash,
        transferIndex: Number(BigInt(log.logIndex)),
        to: recipient,
        ...(sender === undefined ? {} : { from: sender }),
        asset,
        amount: BigInt(log.data),
        blockNumber,
        confirmations: head - blockNumber + 1,
      });
    }

    return { payments, cursor: String(to) };
  }

  /**
   * The `ForwarderFactory.settleBatch` call for this batch: one transaction that deploys each
   * forwarder and flushes it.
   *
   * Prepared, not sent. `SettlementRunner` decides whether to send it — against the gas price,
   * a spend cap and a per-transaction ceiling — assigns the nonce, records it, and replaces it
   * if it sticks. This method used to broadcast through a signer of its own, which was a second
   * settlement design with no nonce and no memory of what was outstanding.
   */
  async prepareSettlement(batch: readonly SettlementRequest[]): Promise<SettlementCall | null> {
    if (batch.length === 0) return null;

    const data = encodeSettleBatch(
      batch.map((request) => {
        const fee = feeOrNone(request.fee);
        return {
          salt: invoiceSalt(request.invoiceId),
          destination: request.payoutAddress,
          feeDestination: fee.feeDestination,
          feeBps: fee.feeBps,
          token: request.asset.contract ?? '0x0000000000000000000000000000000000000000',
        };
      }),
    );

    /**
     * Gas from the chain's own measured figure, per invoice, plus a fixed overhead.
     *
     * Not an `eth_estimateGas` call: an estimate against a factory that has not deployed these
     * forwarders yet is a simulation of state that does not exist, and it fails rather than
     * over-estimating. The registry's `gasDeployAndFlushToken` is the measured cost of one
     * deploy-and-flush, which is exactly what each entry in this batch is; the overhead covers
     * the call itself and the loop around it.
     */
    if (!this.config.create2) {
      throw new Error(`${this.chain} has no forwarder factory configured; nothing here settles`);
    }
    const profile = chainConfig(this.chain).settlement;
    const perInvoice = profile.kind === 'evm' ? BigInt(profile.gasDeployAndFlushToken) : 400_000n;
    return {
      to: this.config.create2.factory,
      data,
      gasLimit: perInvoice * BigInt(batch.length) + 50_000n,
    };
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
    if (body.result === undefined) throw new Error(`${this.chain} rpc ${method}: empty result`);
    return body.result;
  }
}

interface SettlementTuple {
  readonly salt: Uint8Array;
  readonly destination: string;
  readonly token: string;
  /** Omit for no fee. Both fields travel together or neither does. */
  readonly feeDestination?: string | undefined;
  readonly feeBps?: number | undefined;
}

/** `undefined` and an explicit zero fee mean the same thing to the contract. */
function feeOrNone(fee: FeeSplit | undefined): ForwarderFee {
  if (!fee || fee.feeBps === 0) return NO_FEE;
  if (!fee.feeDestination) {
    throw new Error(`a fee of ${fee.feeBps}bps needs a fee destination`);
  }
  return { feeDestination: toChecksumAddress(fee.feeDestination), feeBps: fee.feeBps };
}

/**
 * ABI-encode `settleBatch((bytes32,address,address,uint16,address)[])`.
 *
 * The tuple is fully static, so the array encodes as offset, length, then the
 * elements packed end to end at 160 bytes each. Field order must match the struct
 * declaration in Forwarder.sol exactly — the encoding carries no names, so a
 * transposition of `feeDestination` and `token` would be a silent misdirection of
 * funds rather than a decode error.
 */
export function encodeSettleBatch(items: readonly SettlementTuple[]): string {
  const word = (bytes: Uint8Array): Uint8Array => {
    if (bytes.length > 32) throw new Error('word overflow');
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const numberWord = (value: number): Uint8Array => {
    if (!Number.isInteger(value) || value < 0) throw new Error(`not a non-negative int: ${value}`);
    // Pad to an even number of hex digits, not to two: a batch of 256 renders as
    // '100', which is an odd-length string and not decodable as bytes.
    const hex = value.toString(16);
    return word(fromHex(`0x${hex.length % 2 === 0 ? hex : `0${hex}`}`));
  };

  const offset = word(new Uint8Array([0x20]));
  const length = numberWord(items.length);

  const elements = items.flatMap((item) => {
    // Normalise here rather than requiring every caller to spell out a zero fee.
    // The alternative is that an omitted field reaches `fromHex` as `undefined` and
    // fails several frames down, describing a string method rather than a fee.
    const fee = feeOrNone(
      item.feeBps ? { feeDestination: item.feeDestination ?? '', feeBps: item.feeBps } : undefined,
    );
    return [
      word(item.salt),
      word(fromHex(item.destination)),
      word(fromHex(fee.feeDestination)),
      numberWord(fee.feeBps),
      word(fromHex(item.token)),
    ];
  });

  return SETTLE_BATCH_SELECTOR + toHex(concatBytes(offset, length, ...elements)).slice(2);
}
