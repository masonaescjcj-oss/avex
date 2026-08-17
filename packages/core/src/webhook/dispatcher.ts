import { signWebhook } from './signer.js';

/**
 * Webhook delivery.
 *
 * A merchant learns a payment succeeded through this path, so giving up quietly
 * means they never ship the goods. Delivery therefore retries with backoff, and a
 * delivery that exhausts its attempts is marked for a human rather than dropped.
 *
 * Retries make duplicates inevitable — a merchant may have processed a response we
 * never received — so every attempt carries the same idempotency key, letting them
 * discard what they have already seen. Retrying is only safe for us if it is also
 * safe for them.
 */

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface PendingDelivery {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly attempts: number;
}

export interface DeliveryOutcome {
  readonly id: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly statusCode: number | null;
  readonly error: string | null;
  /** When to try again. Null once the delivery is finished either way. */
  readonly nextAttemptAt: number | null;
}

/** HTTP, injected so delivery can be tested without a server. */
export interface HttpPoster {
  post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ statusCode: number }>;
}

export interface DispatcherConfig {
  readonly maxAttempts: number;
  /** First retry delay; each subsequent one doubles. */
  readonly baseDelayMs: number;
  /** Ceiling on the doubling, so a long outage does not push retries days out. */
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_DISPATCHER: DispatcherConfig = {
  maxAttempts: 8,
  baseDelayMs: 10_000,
  maxDelayMs: 6 * 60 * 60 * 1000,
  timeoutMs: 10_000,
};

/**
 * Delay before attempt number `attempt` (1-based), with jitter.
 *
 * Jitter matters more than it looks: without it, every delivery queued during an
 * outage retries at the same instants, so the merchant's endpoint is hit by the
 * whole backlog at once the moment it recovers — and knocked over again.
 */
export function backoffMs(
  attempt: number,
  config: DispatcherConfig = DEFAULT_DISPATCHER,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, config.maxDelayMs);
  // Full jitter over the interval, rather than a small perturbation.
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * Whether a response means "keep trying".
 *
 * 5xx and network failures are the endpoint's problem and will likely pass. A 4xx
 * is the merchant's configuration — a wrong URL, a rejected signature — and
 * retrying it for hours only delays them noticing. 408 and 429 are the exceptions:
 * both explicitly ask for a retry.
 */
export function shouldRetry(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

export class WebhookDispatcher {
  constructor(
    private readonly http: HttpPoster,
    private readonly config: DispatcherConfig = DEFAULT_DISPATCHER,
    private readonly random: () => number = Math.random,
  ) {}

  async deliver(
    delivery: PendingDelivery,
    now: number = Date.now(),
  ): Promise<DeliveryOutcome> {
    const attempts = delivery.attempts + 1;
    const timestamp = Math.floor(now / 1000);

    const signed = signWebhook(
      delivery.secret,
      { ...delivery.payload, event: delivery.event, id: delivery.id },
      timestamp,
    );

    let statusCode: number | null = null;
    let error: string | null = null;

    try {
      const response = await this.http.post(delivery.url, signed.body, {
        'content-type': 'application/json',
        'avex-signature': signed.header,
        // Stable across retries, so a merchant can recognise a duplicate.
        'avex-idempotency-key': delivery.idempotencyKey,
        'avex-event': delivery.event,
        'avex-attempt': String(attempts),
      });
      statusCode = response.statusCode;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'request failed';
    }

    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      return {
        id: delivery.id,
        status: 'delivered',
        attempts,
        statusCode,
        error: null,
        nextAttemptAt: null,
      };
    }

    if (!shouldRetry(statusCode)) {
      // A permanent rejection. Surfacing it now beats hiding it behind hours of
      // pointless retries the merchant cannot see.
      return {
        id: delivery.id,
        status: 'failed',
        attempts,
        statusCode,
        error: error ?? `endpoint rejected the delivery with ${statusCode}`,
        nextAttemptAt: null,
      };
    }

    if (attempts >= this.config.maxAttempts) {
      // Abandoned, not deleted: a merchant who never received a paid callback has
      // a real problem, and it needs to be visible to an operator.
      return {
        id: delivery.id,
        status: 'abandoned',
        attempts,
        statusCode,
        error: error ?? `gave up after ${attempts} attempts (last status ${statusCode})`,
        nextAttemptAt: null,
      };
    }

    return {
      id: delivery.id,
      status: 'pending',
      attempts,
      statusCode,
      error: error ?? `retryable status ${statusCode}`,
      nextAttemptAt: now + backoffMs(attempts, this.config, this.random),
    };
  }
}

/** Fetch-based transport with a timeout, for production use. */
export class FetchPoster implements HttpPoster {
  constructor(private readonly timeoutMs = DEFAULT_DISPATCHER.timeoutMs) {}

  async post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ statusCode: number }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
      // A merchant endpoint that redirects is misconfigured, and following one
      // could replay a signed payload to a host that was never authorised.
      redirect: 'manual',
    });
    return { statusCode: response.status };
  }
}
