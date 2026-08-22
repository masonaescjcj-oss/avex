import type { Asset, ChainId, GasSnapshot, IncomingPayment } from '../../types.js';
import type {
  ChainAdapter,
  DeriveInput,
  DepositTarget,
  PollCursor,
  PollResult,
  SettlementResult,
} from '../ChainAdapter.js';
import { noSettlementNeeded } from '../ChainAdapter.js';
import type { PriceOracle } from '../evm/EvmAdapter.js';

export interface TonAdapterConfig {
  readonly apiUrl: string;
  readonly apiKey?: string;
  readonly acceptedAssets: readonly Asset[];
  readonly pollLimit: number;
}

interface TonMessage {
  source?: string;
  destination?: string;
  value?: string;
  message?: string;
}

interface TonTransaction {
  transaction_id: { lt: string; hash: string };
  in_msg?: TonMessage;
}

/**
 * Adapter for TON, using the shared-address + comment model.
 *
 * TON carries a native comment field on transfers, which changes the economics
 * completely: instead of deriving an address per invoice and later paying to
 * move the funds, the merchant publishes one address and the payer's own
 * transfer delivers the money, tagged with the invoice's memo. There is no
 * settlement transaction, so settlement costs nothing — and because funds never
 * pass through an address we control, this is the most straightforwardly
 * non-custodial path we offer.
 *
 * The tradeoff is that correctness now depends on the payer including the memo.
 * A transfer without a recognised memo is unmatched, not lost, and needs an
 * operator reconciliation path rather than an automatic credit.
 */
export class TonAdapter implements ChainAdapter {
  readonly chain: ChainId = 'ton';
  readonly addressModel = 'shared-memo' as const;

  constructor(
    private readonly config: TonAdapterConfig,
    private readonly oracle: PriceOracle,
  ) {}

  /**
   * The merchant's own wallet address, plus a memo identifying the invoice.
   * Nothing is derived and nothing is deployed.
   */
  async deriveDepositTarget(input: DeriveInput): Promise<DepositTarget> {
    return {
      address: input.payoutAddress,
      memo: tonMemo(input.invoiceId),
    };
  }

  async probeGas(): Promise<GasSnapshot> {
    return {
      chain: 'ton',
      nativePriceUsd: await this.oracle.nativePriceUsd('ton'),
      observedAt: Date.now(),
    };
  }

  async poll(cursor: PollCursor): Promise<PollResult> {
    const assets = this.config.acceptedAssets;
    const nativeAsset = assets.find((asset) => asset.kind === 'native');
    if (!nativeAsset) return { payments: [], cursor };

    // Watched address is the merchant's; one poll per merchant wallet in
    // production. Kept single-address here to keep the shape clear.
    const params = new URLSearchParams({ limit: String(this.config.pollLimit) });
    if (cursor !== null) params.set('lt', cursor);

    const response = await fetch(`${this.config.apiUrl}/getTransactions?${params}`, {
      headers: this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {},
    });
    if (!response.ok) throw new Error(`ton api: HTTP ${response.status}`);

    const body = (await response.json()) as { result?: TonTransaction[] };
    const transactions = body.result ?? [];

    const payments: IncomingPayment[] = [];
    let latest = cursor;

    for (const transaction of transactions) {
      const inbound = transaction.in_msg;
      if (!inbound?.value || !inbound.destination) continue;

      const memo = inbound.message?.trim();
      if (!memo) continue; // unmatched: needs reconciliation, never auto-credited

      payments.push({
        chain: 'ton',
        txHash: transaction.transaction_id.hash,
        transferIndex: 0,
        to: inbound.destination,
        memo,
        asset: nativeAsset,
        amount: BigInt(inbound.value),
        blockNumber: Number(BigInt(transaction.transaction_id.lt)),
        // TON reaches finality within a block, so anything returned is final.
        confirmations: 1,
      });

      latest = transaction.transaction_id.lt;
    }

    return { payments, cursor: latest };
  }

  /** Nothing to do: the payer's transfer already reached the merchant. */
  prepareSettlement(): Promise<null> {
    return noSettlementNeeded();
  }
}

/**
 * Short, unambiguous memo for an invoice.
 *
 * Kept compact because a payer may retype it by hand, and prefixed so a
 * reconciliation operator can recognise an AVEX memo on sight.
 */
export function tonMemo(invoiceId: string): string {
  return `AVEX-${invoiceId}`;
}
