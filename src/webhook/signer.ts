import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed webhooks.
 *
 * A merchant that ships an unauthenticated webhook endpoint is one forged POST
 * away from giving away goods for free, so the signature covers the timestamp as
 * well as the body: signing only the body lets an attacker replay a genuine
 * "paid" callback forever.
 */

export interface SignedWebhook {
  readonly header: string;
  readonly body: string;
}

const SCHEME = 'v1';

function signature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signWebhook(
  secret: string,
  payload: unknown,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedWebhook {
  const body = JSON.stringify(payload);
  return {
    body,
    header: `t=${timestamp},${SCHEME}=${signature(secret, timestamp, body)}`,
  };
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Verify a webhook. Reference implementation to hand merchants alongside the
 * API docs — most integration bugs are on this side, not ours.
 *
 * @param toleranceSeconds replay window; 5 minutes matches common practice.
 */
export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): VerifyResult {
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index > 0) {
      parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
    }
  }

  const timestampRaw = parts.get('t');
  const provided = parts.get(SCHEME);
  if (!timestampRaw || !provided) return { valid: false, reason: 'malformed signature header' };

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'malformed timestamp' };
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp outside replay window' };
  }

  const expected = Buffer.from(signature(secret, timestamp, body), 'utf8');
  const actual = Buffer.from(provided, 'utf8');

  // Length must match before timingSafeEqual, which throws on unequal buffers.
  if (expected.length !== actual.length) return { valid: false, reason: 'signature mismatch' };
  if (!timingSafeEqual(expected, actual)) return { valid: false, reason: 'signature mismatch' };

  return { valid: true };
}
