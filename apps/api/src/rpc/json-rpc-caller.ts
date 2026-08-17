import type { ChainId, EvmCaller } from '@avex/core';

/**
 * JSON-RPC implementation of the vetting probe's chain access.
 *
 * Holds several endpoints per chain and tries them in order. That redundancy is
 * not optional: hosted providers geofence some regions, and a single endpoint
 * makes contract vetting — and every settlement after it — depend on one vendor
 * being reachable.
 */
export class JsonRpcCaller implements EvmCaller {
  private id = 0;

  constructor(
    private readonly endpoints: Readonly<Record<string, readonly string[]>>,
    private readonly chain: ChainId = 'bsc',
    private readonly timeoutMs = 8000,
  ) {}

  forChain(chain: ChainId): JsonRpcCaller {
    return new JsonRpcCaller(this.endpoints, chain, this.timeoutMs);
  }

  async getCode(address: string): Promise<string> {
    return this.rpc<string>('eth_getCode', [address, 'latest']);
  }

  async call(to: string, data: string): Promise<string> {
    return this.rpc<string>('eth_call', [{ to, data }, 'latest']);
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    return this.rpc<string>('eth_getStorageAt', [address, slot, 'latest']);
  }

  /**
   * `eth_call` with code substituted at an address.
   *
   * Supported by Geth and most hosted providers, but not universally — a provider
   * that rejects the third parameter makes this throw, and the probe then records
   * the transfer checks as `unknown` rather than treating them as passed.
   */
  async callWithCodeOverride(
    to: string,
    data: string,
    overrides: Readonly<Record<string, { code: string }>>,
  ): Promise<string> {
    return this.rpc<string>('eth_call', [{ to, data }, 'latest', overrides]);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const urls = this.endpoints[this.chain] ?? [];
    if (urls.length === 0) {
      throw new Error(`no RPC endpoint configured for ${this.chain}`);
    }

    const failures: string[] = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = (await response.json()) as {
          result?: T;
          error?: { message: string };
        };
        if (body.error) throw new Error(body.error.message);
        if (body.result === undefined) throw new Error('empty result');
        return body.result;
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    throw new Error(`${this.chain} ${method} failed on all endpoints — ${failures.join('; ')}`);
  }
}
