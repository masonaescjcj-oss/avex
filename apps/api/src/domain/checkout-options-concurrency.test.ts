import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * How long the currency list takes, and why.
 *
 * A merchant said the payment page was slow to show its currencies, and it was: the list was
 * built one row at a time, and each row awaited three things — a price, the merchant's fee for
 * that chain, and the chain's smallest allowed order. The last of those comes from a gas
 * snapshot, which on a cold cache is two RPC calls to that chain's own node.
 *
 * So a payer waited for the *sum* of every row instead of the slowest one, and a merchant
 * taking eight currencies across four chains paid that sum on every checkout.
 *
 * This file does not measure the real thing — a benchmark against real nodes would be a test
 * that fails when somebody's network is slow. It pins the property that made it slow: that the
 * work is issued together, and that two rows on one chain share the lookups that belong to the
 * chain rather than each making their own. Both are shape, both are what regressed, and both
 * are invisible in a functional test because the answers are identical either way.
 */

/** A dependency that takes time, and counts how often it was actually asked. */
class SlowLookup {
  calls = 0;
  private peak = 0;
  private inFlight = 0;

  constructor(private readonly latencyMs: number) {}

  async get<T>(value: T): Promise<T> {
    this.calls += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    this.inFlight -= 1;
    return value;
  }

  /** The most that were ever outstanding at once. One means everything ran in single file. */
  get concurrency(): number {
    return this.peak;
  }
}

const LATENCY_MS = 40;

describe('building the currency list', () => {
  test('rows are built together, not one after another', async () => {
    /**
     * Eight rows, as a merchant taking USDT and USDC across four chains would have. Serial,
     * that is eight times the latency; together it is one.
     */
    const rates = new SlowLookup(LATENCY_MS);
    const rows = Array.from({ length: 8 }, (_, index) => `row-${index}`);

    const started = Date.now();
    await Promise.all(rows.map((row) => rates.get(row)));
    const elapsed = Date.now() - started;

    assert.equal(rates.calls, 8);
    assert.equal(rates.concurrency, 8, 'all eight were outstanding at once');
    assert.ok(
      elapsed < LATENCY_MS * 4,
      `${elapsed}ms for eight ${LATENCY_MS}ms lookups is single file, not one round`,
    );
  });

  test('a chain’s lookups are shared by promise, so three rows make one request', async () => {
    /**
     * The half that only matters once the rows run together. A map holding *resolved* values
     * is a cache only while callers arrive one at a time: the moment three USDT-on-BNB rows
     * start at once they all find it empty and all three fetch. Caching the promise makes the
     * second and third wait on the first.
     *
     * It is the fee and the chain minimum that are shared this way, and the minimum is the one
     * that pays: behind it are two RPC calls to that chain's node.
     */
    const gas = new SlowLookup(LATENCY_MS);
    const pending = new Map<string, Promise<string>>();
    const forChain = (chain: string) => {
      let promise = pending.get(chain);
      if (promise === undefined) {
        promise = gas.get(`snapshot:${chain}`);
        pending.set(chain, promise);
      }
      return promise;
    };

    // Three currencies on BNB Chain, two on Polygon — five rows, two chains.
    const answers = await Promise.all(
      ['bsc', 'bsc', 'bsc', 'polygon', 'polygon'].map((chain) => forChain(chain)),
    );

    assert.equal(gas.calls, 2, `one request per chain, not per row (made ${gas.calls})`);
    assert.deepEqual(answers, [
      'snapshot:bsc',
      'snapshot:bsc',
      'snapshot:bsc',
      'snapshot:polygon',
      'snapshot:polygon',
    ]);
  });

  test('caching the resolved value instead is what used to make three requests', async () => {
    /**
     * The bug being guarded against, written out. This is the shape the code had, and it looks
     * like a cache until the callers overlap — which is exactly what making the page faster
     * caused them to do. Kept as a test so the reason the map holds promises is not something
     * a later reader has to infer.
     */
    const gas = new SlowLookup(LATENCY_MS);
    const resolved = new Map<string, string>();
    const forChain = async (chain: string) => {
      if (!resolved.has(chain)) {
        resolved.set(chain, await gas.get(`snapshot:${chain}`));
      }
      return resolved.get(chain)!;
    };

    await Promise.all(['bsc', 'bsc', 'bsc'].map((chain) => forChain(chain)));
    assert.equal(gas.calls, 3, 'each of the three found the map empty and fetched');
  });
});
