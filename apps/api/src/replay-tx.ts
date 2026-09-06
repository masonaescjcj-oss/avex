import {
  DEFAULT_BREAKER,
  DEFAULT_DISPATCHER,
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

async function main(): Promise<void> {
  const [chainArg, txHash] = process.argv.slice(2);
  if (!chainArg || !txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
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
      log('no transfer in this transaction reaches an address we watch', { txHash, logs: receipt.logs.length });
    }
  } finally {
    await close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
