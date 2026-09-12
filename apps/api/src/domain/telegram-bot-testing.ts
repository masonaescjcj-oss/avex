import { SecretBox } from '../auth/secret-box.js';
import type { Database } from '../db/client.js';
import type { AuditService } from './audit.js';
import { TelegramBotError, TelegramBotService, type TelegramTransport } from './telegram-bot-service.js';

/**
 * A Telegram bot service for suites that are not about Telegram.
 *
 * Every test that builds an `AppContext` needs one, and almost none of them care: they are
 * testing invoices, or checkouts, or the admin panel, and Telegram is a field in a struct they
 * have to fill in. This gives them one that is honest about doing nothing — every call to
 * Telegram throws — rather than a stub that silently pretends to succeed.
 *
 * A suite that *is* about Telegram passes its own transport and asserts on what was asked.
 */

/** Records what would have been sent, and answers whatever the test lines up. */
export class FakeTelegramTransport implements TelegramTransport {
  readonly calls: { token: string; method: string; body: Record<string, unknown> }[] = [];

  constructor(private readonly answers: Record<string, unknown | (() => unknown)> = {}) {}

  async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    this.calls.push({ token, method, body });

    const answer = this.answers[method];
    if (answer === undefined) {
      throw new TelegramBotError('telegram_refused', `this fake has no answer for ${method}`);
    }
    const value = typeof answer === 'function' ? (answer as () => unknown)() : answer;
    if (value instanceof Error) throw value;
    return value as T;
  }

  /** The last body sent to a method, for a test that cares what we asked Telegram to do. */
  lastCall(method: string): Record<string, unknown> | undefined {
    return [...this.calls].reverse().find((call) => call.method === method)?.body;
  }
}

/** One that refuses everything: the right default for a suite with no bot in it. */
export class OfflineTelegramTransport implements TelegramTransport {
  async call<T>(_token: string, method: string): Promise<T> {
    throw new TelegramBotError('unreachable', `no Telegram in this test (${method})`);
  }
}

export const TEST_ENCRYPTION_KEY = 'a-test-token-encryption-key';

export function testTelegramService(
  db: Database,
  audit: AuditService,
  transport: TelegramTransport = new OfflineTelegramTransport(),
  publicApiUrl: string | undefined = 'https://api.test.avex',
): TelegramBotService {
  return new TelegramBotService(db, audit, new SecretBox(TEST_ENCRYPTION_KEY), transport, publicApiUrl);
}
