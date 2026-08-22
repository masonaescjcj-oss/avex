import { chainConfig } from '@avex/core';
import type { ChainId, GasSnapshot } from '@avex/core';

/**
 * What a chain costs to use, right now, for the one caller that needs it before an invoice
 * exists.
 *
 * The settlement queue already probes gas — it asks the chain adapter, which holds an RPC
 * client and a price oracle of its own. This exists because invoice creation cannot: it runs
 * inside an HTTP request, before there is an address or a payment, and it needs the figure to
 * decide what to charge the payer for moving their money. The fee is a constructor argument to
 * the forwarder, so the deposit address commits to it — which means the number has to be
 * settled at creation and can never be revisited.
 *
 * ## Why every failure is a `null` and never a throw
 *
 * A gas probe is a network call to a third party, on the path that takes money. If it were
 * allowed to fail an invoice, an unreachable node would stop a merchant selling — and the
 * thing it would be protecting is a few cents of gas. So the contract is that this answers
 * `null` when it cannot answer, and the caller charges no network fee: we absorb the cost, as
 * we did before any of this existed. That is the only direction of failure that costs nobody
 * but us.
 */
export interface GasOracle {
  /** A complete snapshot, or `null` when there is nothing trustworthy to report. */
  snapshot(chain: ChainId): Promise<GasSnapshot | null>;
}

/** The slice of a JSON-RPC client this needs. `JsonRpcCaller` satisfies it. */
export interface GasRpc {
  forChain(chain: ChainId): {
    request<T>(method: string, params: readonly unknown[]): Promise<T>;
  };
}

/** The slice of the pricing engine this needs. `PriceService` satisfies it. */
export interface NativePrices {
  nativePriceUsd(chain: ChainId): Promise<number>;
}

interface CacheEntry {
  readonly snapshot: GasSnapshot;
  readonly at: number;
}

/**
 * Fresh enough for this purpose, and rate-limited so invoice creation is not one RPC call per
 * invoice.
 *
 * Thirty seconds. The figure it feeds is a percentage of an invoice rounded up to a basis
 * point, so a gas price that moved ten per cent inside the window changes the charge by a
 * fraction of a cent on a typical order. Against that, a probe per invoice would put a
 * third-party round trip in front of every checkout and a rate limit in front of a busy one.
 */
const DEFAULT_TTL_MS = 30_000;

/**
 * How stale a snapshot may be and still be used when a refresh fails.
 *
 * Ten minutes. A node that has been unreachable for longer than that has stopped being a
 * momentary blip, and a gas price from before it went down is no longer evidence about the
 * chain — better to charge nothing and absorb it than to charge a payer against a number we
 * would not defend.
 */
const MAX_STALE_MS = 10 * 60 * 1000;

export class RpcGasOracle implements GasOracle {
  private readonly cache = new Map<ChainId, CacheEntry>();

  constructor(
    private readonly rpc: GasRpc,
    private readonly prices: NativePrices,
    private readonly warn: (message: string) => void = () => {},
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async snapshot(chain: ChainId, now: number = Date.now()): Promise<GasSnapshot | null> {
    /**
     * Chains we send no transaction on are refused rather than measured.
     *
     * TON's one shared wallet and TRON's pool of the merchant's own addresses both receive the
     * payer's transfer directly, so there is no settlement to pay for. Answering `null` rather
     * than a snapshot with a zero cost keeps the honest reading: this has no gas figure for a
     * chain where we spend no gas, and the caller's own rule — no snapshot, no surcharge —
     * produces exactly the right charge of nothing.
     */
    if (chainConfig(chain).settlement.kind !== 'evm') return null;

    const cached = this.cache.get(chain);
    if (cached && now - cached.at < this.ttlMs) return cached.snapshot;

    try {
      /**
       * The same two calls the EVM adapter makes, and the priority fee is optional in the same
       * way: chains without EIP-1559 reject the method, and `eth_gasPrice` already includes
       * what a transaction has to pay there.
       */
      const client = this.rpc.forChain(chain);
      const [gasPriceHex, priorityHex, nativePriceUsd] = await Promise.all([
        client.request<string>('eth_gasPrice', []),
        client.request<string>('eth_maxPriorityFeePerGas', []).catch(() => '0x0'),
        this.prices.nativePriceUsd(chain),
      ]);

      const snapshot: GasSnapshot = {
        chain,
        nativePriceUsd,
        feePerGasWei: BigInt(gasPriceHex) + BigInt(priorityHex),
        observedAt: now,
      };
      this.cache.set(chain, { snapshot, at: now });
      return snapshot;
    } catch (error) {
      /**
       * A recent snapshot outlives the node that produced it, briefly.
       *
       * The alternative on a flaky endpoint is a charge that appears and disappears between two
       * invoices a minute apart, which a merchant reading their own numbers cannot explain.
       */
      if (cached && now - cached.at < MAX_STALE_MS) return cached.snapshot;
      this.warn(
        `gas oracle: no snapshot for ${chain} — ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }
}
