import {
  DEFAULT_BREAKER,
  TonAdapter,
  TonApi,
  rateToDecimalString,
  DEFAULT_DISPATCHER,
  NATIVE_TRANSFER_INDEX,
  FetchPoster,
  PriceService,
  WebhookDispatcher,
  chainConfig,
  createPriceSources,
  isTronAddress,
  normalizeTronAddress,
  toChecksumAddress,
  tronAddressToEvmHex,
} from '@avex/core';
import type { Asset, ChainId, IncomingPayment } from '@avex/core';

import { createDatabase } from './db/client.js';
import { DatabaseAddressBook } from './domain/address-book.js';
import { AssetService } from './domain/asset-service.js';
import { AuditService } from './domain/audit.js';
import { CommissionLedger } from './domain/commission-ledger.js';
import { DatabasePaymentSink } from './domain/payment-sink.js';
import { paymentValueSource, paymentValueUsd } from './domain/payment-valuation.js';
import { ReconciliationService } from './domain/reconciliation-service.js';
import { WebhookService } from './domain/webhook-service.js';
import { loadEnv } from './env.js';

/**
 * Credit one transaction by its hash, without the watcher.
 *
 *     node dist/replay-tx.js <chain> <txHash>
 *
 * For the payment the watcher did not see. The ordinary reasons: the chain's node refused
 * every log query for an hour while the transfer sat in the merchant's wallet, and by the time
 * polling recovered the cursor had moved past the block; or the process was down for longer
 * than the public node keeps logs. Rewinding the cursor would rescan thousands of blocks the
 * same node will not serve. The receipt of one transaction, by hash, every node serves.
 *
 * What it does is exactly what a poll would have done with this transaction: read its
 * `Transfer` logs, keep the ones to an address in the address book in a token from the
 * catalogue, and hand each to the same payment sink with the same rules — exact amount,
 * same sender, sole candidate, or parked for a person. Nothing here decides anything the
 * watcher would not; it only supplies the transaction the watcher never saw. Idempotent by the
 * sink's identity key: replaying a transaction already credited is a no-op that says so.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

interface Receipt {
  readonly blockNumber: string;
  readonly status?: string;
  readonly logs: readonly RpcLog[];
}

/**
 * The transaction itself, which is the only place a native transfer is recorded.
 *
 * A receipt has logs and no value, so a payment in the chain's own coin — BNB, ETH, POL, TRX
 * — is invisible in it. That is the whole reason the watcher has a separate pass for those,
 * and the reason this reads both: an operator crediting a payment by hand does not know or
 * care which kind it was.
 */
interface Transaction {
  readonly to?: string | null;
  readonly from?: string;
  readonly value?: string;
  readonly blockNumber?: string;
}

async function main(): Promise<void> {
  const [chainArg, txHash] = process.argv.slice(2);
  if (!chainArg || !txHash) {
    console.error(
      'usage: node dist/replay-tx.js <chain> <transaction hash>\n' +
        '       an EVM or TRON chain takes an 0x… hash; ton takes the hash an explorer shows',
    );
    process.exit(2);
  }

  /**
   * TON is answered by an indexer rather than a node, so it has its own path.
   *
   * Split here rather than inside the RPC helper because nothing below applies: there are no
   * receipts, no logs, no block numbers, and the transaction is fetched from toncenter by
   * hash. What the two share is the part that matters — the same payment sink, with the same
   * matching rules and the same idempotency.
   */
  if (chainArg === 'ton') {
    await replayTon(txHash);
    return;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    console.error('usage: node dist/replay-tx.js <chain> <0x…transaction hash>');
    process.exit(2);
  }
  const chain = chainArg as ChainId;
  const config = chainConfig(chain);
  const env = loadEnv();
  const urls = env.EVM_RPC_URLS[chain];
  if (!urls || urls.length === 0) {
    console.error(`no RPC endpoint configured for ${chain} (EVM_RPC_URLS)`);
    process.exit(2);
  }

  let rpcId = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(urls[0]!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if (!response.ok) throw new Error(`${chain} rpc ${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${chain} rpc ${method}: ${body.error.message}`);
    if (body.result === undefined || body.result === null) {
      throw new Error(`${chain} rpc ${method}: nothing returned — is the hash right, and on this chain?`);
    }
    return body.result;
  };

  const { db, close } = createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE, max: 2 });
  try {
    const log = (message: string, data?: unknown): void => {
      console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(data ?? {}) }));
    };
    const audit = new AuditService(db);
    const webhooks = new WebhookService(
      db,
      new WebhookDispatcher(new FetchPoster(DEFAULT_DISPATCHER.timeoutMs)),
      (message) => log('webhook warning', { detail: message }),
    );
    const prices = new PriceService(createPriceSources(env.PRICE_SOURCES), {
      aggregation: {
        minSources: env.PRICE_MIN_SOURCES,
        outlierToleranceBps: env.PRICE_OUTLIER_TOLERANCE_BPS,
        maxDispersionBps: env.PRICE_MAX_DISPERSION_BPS,
        maxStalenessMs: env.PRICE_MAX_STALENESS_MS,
      },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: env.PRICE_CACHE_TTL_MS,
      staleFallbackMs: env.PRICE_STALE_FALLBACK_MS,
    });
    const sink = new DatabasePaymentSink(
      db,
      audit,
      webhooks,
      paymentValueUsd(prices),
      paymentValueSource(),
      new CommissionLedger(db),
    );
    sink.parkUnmatchedIn(new ReconciliationService(db, audit, sink));

    // The same catalogue the watcher reads, so an unknown contract is ignored here too.
    const probeStub = {
      async probe(): Promise<never> {
        throw new Error('replay does not vet contracts');
      },
    } as unknown as ConstructorParameters<typeof AssetService>[2];
    const catalogue = await new AssetService(db, audit, probeStub, []).catalogue();
    const isTron = config.addressModel === 'pooled' && chain === 'tron';
    const byContract = new Map<string, Asset>();
    for (const row of catalogue) {
      if (row.chain !== chain || !row.listed || row.verdict !== 'approved' || row.contract === null) continue;
      const key = isTron
        ? isTronAddress(row.contract) ? tronAddressToEvmHex(row.contract).toLowerCase() : null
        : row.contract.toLowerCase();
      if (key === null) continue;
      byContract.set(key, {
        symbol: row.symbol,
        chain,
        decimals: row.decimals,
        kind: row.kind as Asset['kind'],
        contract: row.contract,
      });
    }
    const addressBook = new DatabaseAddressBook(db, chain);

    const receipt = await rpc<Receipt>('eth_getTransactionReceipt', [txHash]);
    if (receipt.status !== undefined && receipt.status !== '0x1') {
      log('the transaction failed on chain; nothing to credit', { txHash, status: receipt.status });
      return;
    }
    const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
    const blockNumber = Number(BigInt(receipt.blockNumber));

    let considered = 0;

    /**
     * The chain's own coin first, from the transaction rather than the receipt.
     *
     * This is the case the watcher can genuinely miss — a native payment that landed while
     * the process was restarting, so the balance baseline it took already included it — and
     * it is what the warning in `native-transfers.ts` points an operator here for.
     */
    const nativeAsset = catalogue.find(
      (row) => row.chain === chain && row.listed && row.verdict === 'approved' && row.kind === 'native',
    );
    if (nativeAsset !== undefined) {
      const transaction = await rpc<Transaction>('eth_getTransactionByHash', [txHash]);
      const rawTo = transaction.to ?? null;
      const value = transaction.value === undefined ? 0n : BigInt(transaction.value);
      if (rawTo !== null && value > 0n) {
        const to = isTron ? normalizeTronAddress(rawTo) : toChecksumAddress(rawTo);
        if ((await addressBook.lookup(to)) !== null) {
          considered += 1;
          const from = transaction.from === undefined
            ? undefined
            : isTron ? normalizeTronAddress(transaction.from) : toChecksumAddress(transaction.from);
          const payment: IncomingPayment = {
            chain,
            txHash,
            transferIndex: NATIVE_TRANSFER_INDEX,
            to,
            ...(from === undefined ? {} : { from }),
            asset: {
              symbol: nativeAsset.symbol,
              chain,
              decimals: nativeAsset.decimals,
              kind: 'native',
            },
            amount: value,
            blockNumber,
            confirmations: head - blockNumber + 1,
          };
          const outcome = await sink.credit(payment);
          log('replayed', {
            outcome,
            to,
            from,
            asset: nativeAsset.symbol,
            amount: `${(Number(value) / 10 ** nativeAsset.decimals).toString()} ${nativeAsset.symbol}`,
            blockNumber,
            confirmations: payment.confirmations,
          });
        }
      }
    }
    for (const entry of receipt.logs) {
      if (entry.topics[0] !== TRANSFER_TOPIC || entry.topics.length < 3) continue;
      const asset = byContract.get(entry.address.toLowerCase());
      if (asset === undefined) {
        log('transfer in a token not in the catalogue; skipped', { contract: entry.address });
        continue;
      }
      const rawTo = `0x${entry.topics[2]!.slice(26)}`;
      const rawFrom = `0x${entry.topics[1]!.slice(26)}`;
      const to = isTron ? normalizeTronAddress(rawTo) : toChecksumAddress(rawTo);
      const from = isTron ? normalizeTronAddress(rawFrom) : toChecksumAddress(rawFrom);
      if ((await addressBook.lookup(to)) === null) {
        log('transfer to an address no invoice uses; skipped', { to });
        continue;
      }
      considered += 1;
      const payment: IncomingPayment = {
        chain,
        txHash,
        transferIndex: Number(BigInt(entry.logIndex)),
        to,
        from,
        asset,
        amount: BigInt(entry.data),
        blockNumber,
        confirmations: head - blockNumber + 1,
      };
      const outcome = await sink.credit(payment);
      log('replayed', {
        outcome,
        to,
        from,
        asset: asset.symbol,
        amount: `${(Number(payment.amount) / 10 ** asset.decimals).toString()} ${asset.symbol}`,
        blockNumber,
        confirmations: payment.confirmations,
      });
    }
    if (considered === 0) {
      log('no transfer in this transaction reaches an address we watch', {
        txHash,
        logs: receipt.logs.length,
      });
    }
  } finally {
    await close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Credit one TON transaction by its hash.
 *
 * For the transfer the watcher never saw. There have been two: a merchant's first two TON
 * payments, into a wallet that had never sent anything and therefore had no code deployed —
 * which makes TON report the transaction as `aborted` even though the money lands. The adapter
 * skipped those, and this is how the two are recovered.
 *
 * It deliberately reuses `TonAdapter.paymentsForHash` rather than reading the transaction
 * itself. The rule about which transfers actually landed is subtle enough to have been wrong
 * once; a recovery tool with its own copy of it would be a second place for the same mistake.
 */
async function replayTon(txHash: string): Promise<void> {
  const env = loadEnv();
  if (!env.TON_API_URL) {
    console.error('no TON indexer configured (TON_API_URL)');
    process.exit(2);
  }

  const { db, close } = createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE, max: 2 });
  try {
    const log = (message: string, data?: unknown): void => {
      console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(data ?? {}) }));
    };
    const audit = new AuditService(db);
    const webhooks = new WebhookService(
      db,
      new WebhookDispatcher(new FetchPoster(DEFAULT_DISPATCHER.timeoutMs)),
      (message) => log('webhook warning', { detail: message }),
    );
    const prices = new PriceService(createPriceSources(env.PRICE_SOURCES), {
      aggregation: {
        minSources: env.PRICE_MIN_SOURCES,
        outlierToleranceBps: env.PRICE_OUTLIER_TOLERANCE_BPS,
        maxDispersionBps: env.PRICE_MAX_DISPERSION_BPS,
        maxStalenessMs: env.PRICE_MAX_STALENESS_MS,
      },
      breaker: DEFAULT_BREAKER,
      cacheTtlMs: env.PRICE_CACHE_TTL_MS,
      staleFallbackMs: env.PRICE_STALE_FALLBACK_MS,
    });
    const sink = new DatabasePaymentSink(
      db,
      audit,
      webhooks,
      paymentValueUsd(prices),
      paymentValueSource(),
      new CommissionLedger(db),
    );
    sink.parkUnmatchedIn(new ReconciliationService(db, audit, sink));

    /**
     * The catalogue, read the same way the watcher reads it: listed and approved only.
     *
     * The probe is a stub that throws — this tool never vets a contract, and passing a real
     * one would leave a prober wired up that could make RPC calls nobody asked for.
     */
    const probeStub = {
      async probe(): Promise<never> {
        throw new Error('replay-tx does not vet contracts');
      },
    } as unknown as ConstructorParameters<typeof AssetService>[2];

    const catalogue = await new AssetService(db, audit, probeStub, []).catalogue();
    const accepted: Asset[] = catalogue
      .filter((row) => row.chain === 'ton' && row.listed && row.verdict === 'approved')
      .map((row) => ({
        symbol: row.symbol,
        chain: 'ton' as const,
        decimals: row.decimals,
        kind: row.kind as Asset['kind'],
        ...(row.contract === null ? {} : { contract: row.contract }),
      }));
    const native = accepted.find((asset) => asset.kind === 'native');
    if (!native) {
      log('TON itself is not an accepted asset here, so a native transfer cannot be credited');
      return;
    }

    const adapter = new TonAdapter(
      { acceptedAssets: accepted, warn: (message) => log('ton warning', { detail: message }) },
      new TonApi({
        apiUrl: env.TON_API_URL,
        ...(env.TON_API_KEY === undefined ? {} : { apiKey: env.TON_API_KEY }),
      }),
      new DatabaseAddressBook(db, 'ton'),
      { nativePriceUsd: async () => Number(rateToDecimalString(await prices.requireRate('TON'), 8)) },
    );

    const payments = await adapter.paymentsForHash(txHash, native);
    if (payments.length === 0) {
      log('nothing in that transaction reaches a wallet we watch', { txHash });
      return;
    }

    for (const payment of payments) {
      const outcome = await sink.credit(payment);
      log('replayed', {
        outcome,
        to: payment.to,
        ...(payment.memo === undefined ? {} : { memo: payment.memo }),
        amount: `${Number(payment.amount) / 10 ** native.decimals} ${native.symbol}`,
      });
    }
  } finally {
    await close();
  }
}
