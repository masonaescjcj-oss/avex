import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { SecretBox } from '../auth/secret-box.js';
import type { Database } from '../db/client.js';
import { telegramBots } from '../db/schema.js';
import type { AuditService } from './audit.js';

/**
 * The merchant's own Telegram bot, driven by us.
 *
 * There are two ways to take Stars, and this is the second one. In the first the merchant's
 * bot does everything — it calls `createInvoiceLink` itself and posts the charge back to us —
 * and nothing about their bot is stored here at all. That path is smaller, needs no
 * credential, and stays supported.
 *
 * This one exists because the first cannot put Stars on the hosted checkout. A payer choosing
 * between TON and USDT and Stars is choosing on one page, and that page has no bot. So the
 * merchant hands us a bot token, we ask Telegram for the pay link when a payer picks Stars,
 * and we answer the bot's payment updates on their behalf.
 *
 * ## What connecting a bot costs the merchant
 *
 * A bot has exactly one webhook. Pointing it here takes over *every* update that bot receives,
 * including the messages their shop bot answers. That is not something to do quietly, so:
 * `forwardUrl` hands on everything we do not handle, the merchant is told what will happen
 * before they confirm, and disconnecting removes the webhook rather than leaving Telegram
 * posting at a URL that has stopped caring.
 *
 * ## Why the token is encrypted and not hashed
 *
 * Every other credential here is hashed, because nothing needs the original back. This one is
 * presented to Telegram on every call. See `SecretBox`.
 */

export type TelegramErrorCode =
  | 'not_configured'
  | 'bad_token'
  | 'telegram_refused'
  | 'already_connected'
  | 'taken'
  | 'no_bot'
  | 'unreachable';

export class TelegramBotError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramBotError';
  }
}

/** The slice of Telegram's Bot API this needs, so tests can answer it without a network. */
export interface TelegramTransport {
  call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T>;
}

interface BotIdentity {
  readonly id: number;
  readonly username?: string;
  readonly is_bot?: boolean;
  readonly can_join_groups?: boolean;
}

/** The real one. Every call is a POST; Telegram's own envelope is unwrapped here. */
export class FetchTelegramTransport implements TelegramTransport {
  constructor(
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly timeoutMs = 8000,
  ) {}

  async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TelegramBotError(
        'unreachable',
        `Telegram could not be reached: ${error instanceof Error ? error.message : 'request failed'}`,
      );
    }

    const envelope = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: T; description?: string; error_code?: number }
      | null;

    if (!envelope || envelope.ok !== true) {
      /**
       * Telegram's own words, passed through.
       *
       * It says exactly what is wrong — "Unauthorized", "Bot domain invalid", "PAYMENT_
       * PROVIDER_INVALID" — and a merchant debugging their own bot needs that sentence, not
       * a translation of it into something vaguer.
       */
      const detail = envelope?.description ?? `HTTP ${response.status}`;
      throw new TelegramBotError(
        response.status === 401 ? 'bad_token' : 'telegram_refused',
        detail,
      );
    }

    return envelope.result as T;
  }
}

export interface ConnectedBot {
  readonly botId: string;
  readonly username: string;
  readonly forwardUrl: string | null;
  readonly verifiedAt: Date;
  readonly lastUpdateAt: Date | null;
  readonly webhookUrl: string;
}

export class TelegramBotService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly transport: TelegramTransport,
    /** Where this API answers publicly, so Telegram can be told where to deliver. */
    private readonly publicApiUrl: string | undefined,
  ) {}

  /** The URL Telegram is told to post to. One per bot, so a delivery names its own row. */
  webhookUrlFor(botId: string): string {
    if (!this.publicApiUrl) {
      throw new TelegramBotError(
        'not_configured',
        'This server has not been told its own public address, so Telegram cannot be given ' +
          'one to deliver to. Set PUBLIC_API_URL in api.env and restart.',
      );
    }
    return `${this.publicApiUrl.replace(/\/$/, '')}/telegram/updates/${botId}`;
  }

  async connected(organizationId: string): Promise<ConnectedBot | null> {
    const [row] = await this.db
      .select()
      .from(telegramBots)
      .where(eq(telegramBots.organizationId, organizationId))
      .limit(1);
    if (!row) return null;

    return {
      botId: row.botId,
      username: row.username,
      forwardUrl: row.forwardUrl,
      verifiedAt: row.verifiedAt,
      lastUpdateAt: row.lastUpdateAt,
      // Built rather than stored: a server that moves gets the new one without a migration.
      webhookUrl: this.publicApiUrl ? this.webhookUrlFor(row.botId) : '',
    };
  }

  /**
   * Connect a bot: prove the token, then point its webhook here.
   *
   * In that order, and the order is the point. `getMe` is a read — a wrong token fails
   * harmlessly. `setWebhook` is a write to somebody's bot, so it happens only once the token
   * has been shown to be what the merchant thinks it is.
   */
  async connect(
    organizationId: string,
    input: { readonly token: string; readonly forwardUrl?: string | undefined },
    actor: { readonly userId: string | null; readonly ip?: string | undefined },
  ): Promise<ConnectedBot> {
    const token = input.token.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      throw new TelegramBotError(
        'bad_token',
        'That does not look like a bot token. BotFather gives you one shaped like ' +
          '123456789:AA… — copy the whole line.',
      );
    }

    const me = await this.transport.call<BotIdentity>(token, 'getMe', {});
    if (!me || typeof me.id !== 'number') {
      throw new TelegramBotError('telegram_refused', 'Telegram did not identify that token.');
    }
    const botId = String(me.id);

    /**
     * A bot already connected elsewhere is refused, not moved.
     *
     * One webhook per bot: taking it would stop the other organisation's payments and they
     * would learn about it from a customer. Whoever has it has to release it first.
     */
    const [claimed] = await this.db
      .select({ organizationId: telegramBots.organizationId })
      .from(telegramBots)
      .where(eq(telegramBots.botId, botId))
      .limit(1);
    if (claimed && claimed.organizationId !== organizationId) {
      throw new TelegramBotError(
        'taken',
        'That bot is already connected to another AVEX account. Disconnect it there first, ' +
          'or use a different bot.',
      );
    }

    const webhookSecret = randomBytes(24).toString('base64url');
    const webhookUrl = this.webhookUrlFor(botId);

    /**
     * `allowed_updates` is the narrowest list that works.
     *
     * Two of them are ours — the pre-checkout question and the payment itself — and `message`
     * is there only because a merchant forwarding to their own bot needs it to arrive. Asking
     * for everything would have us receiving edits, reactions and channel posts we would only
     * forward, on somebody else's bandwidth.
     */
    await this.transport.call(token, 'setWebhook', {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ['pre_checkout_query', 'message', 'callback_query'],
      drop_pending_updates: true,
    });

    const row = {
      organizationId,
      botId,
      username: me.username ?? botId,
      webhookSecret,
      forwardUrl: input.forwardUrl?.trim() || null,
      verifiedAt: new Date(),
    };

    /**
     * Sealed after the insert, because the seal binds to the row's id.
     *
     * A two-step write rather than one, and worth it: binding to the id is what stops a
     * ciphertext being lifted into another organisation's row and opening there.
     */
    const [saved] = await this.db
      .insert(telegramBots)
      .values({ ...row, tokenSealed: 'pending' })
      .onConflictDoUpdate({
        target: telegramBots.organizationId,
        set: { ...row, tokenSealed: 'pending', lastUpdateAt: null },
      })
      .returning();

    await this.db
      .update(telegramBots)
      .set({ tokenSealed: this.secrets.seal(token, saved!.id) })
      .where(eq(telegramBots.id, saved!.id));

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      apiKeyId: null,
      action: 'telegram.bot_connected',
      targetType: 'organization',
      targetId: organizationId,
      // The bot, never the token. An audit row is read by more people than the table is.
      metadata: { botId, username: row.username, forwarding: row.forwardUrl !== null },
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
    });

    return {
      botId,
      username: row.username,
      forwardUrl: row.forwardUrl,
      verifiedAt: row.verifiedAt,
      lastUpdateAt: null,
      webhookUrl,
    };
  }

  /** Where to send updates that are not ours. Changed on its own, without re-pasting a token. */
  async setForwardUrl(organizationId: string, forwardUrl: string | null): Promise<ConnectedBot> {
    const [updated] = await this.db
      .update(telegramBots)
      .set({ forwardUrl: forwardUrl?.trim() || null })
      .where(eq(telegramBots.organizationId, organizationId))
      .returning();
    if (!updated) throw new TelegramBotError('no_bot', 'No Telegram bot is connected.');

    return {
      botId: updated.botId,
      username: updated.username,
      forwardUrl: updated.forwardUrl,
      verifiedAt: updated.verifiedAt,
      lastUpdateAt: updated.lastUpdateAt,
      webhookUrl: this.publicApiUrl ? this.webhookUrlFor(updated.botId) : '',
    };
  }

  /**
   * Disconnect, removing the webhook first.
   *
   * The row goes whatever Telegram says. A token that has been revoked cannot have its
   * webhook removed, and refusing to forget the bot because of that would leave a merchant
   * unable to connect a replacement — so a refusal from Telegram is noted and stepped past.
   */
  async disconnect(
    organizationId: string,
    actor: { readonly userId: string | null; readonly ip?: string | undefined },
  ): Promise<{ readonly webhookRemoved: boolean }> {
    const [row] = await this.db
      .select()
      .from(telegramBots)
      .where(eq(telegramBots.organizationId, organizationId))
      .limit(1);
    if (!row) throw new TelegramBotError('no_bot', 'No Telegram bot is connected.');

    let webhookRemoved = true;
    try {
      const token = this.secrets.open(row.tokenSealed, row.id);
      await this.transport.call(token, 'deleteWebhook', { drop_pending_updates: false });
    } catch {
      webhookRemoved = false;
    }

    await this.db.delete(telegramBots).where(eq(telegramBots.id, row.id));

    await this.audit.record({
      organizationId,
      userId: actor.userId,
      apiKeyId: null,
      action: 'telegram.bot_disconnected',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { botId: row.botId, webhookRemoved },
      ...(actor.ip === undefined ? {} : { ip: actor.ip }),
    });

    return { webhookRemoved };
  }

  /**
   * The `t.me/$…` link a payer follows, for one invoice.
   *
   * `payload` is the invoice's own deposit column — `telegram:<uuid>` — and is what comes back
   * on both the pre-checkout question and the payment, which is how a delivery names the
   * invoice it belongs to. Telegram echoes it verbatim and never interprets it.
   */
  async payLink(
    organizationId: string,
    invoice: {
      readonly title: string;
      readonly description: string;
      readonly payload: string;
      readonly stars: bigint;
    },
  ): Promise<string> {
    const [row] = await this.db
      .select()
      .from(telegramBots)
      .where(eq(telegramBots.organizationId, organizationId))
      .limit(1);
    if (!row) throw new TelegramBotError('no_bot', 'No Telegram bot is connected.');

    if (invoice.stars <= 0n) {
      throw new TelegramBotError('telegram_refused', 'A Stars invoice must ask for at least one Star.');
    }

    const token = this.secrets.open(row.tokenSealed, row.id);
    return this.transport.call<string>(token, 'createInvoiceLink', {
      title: clamp(invoice.title, 32),
      description: clamp(invoice.description, 255),
      payload: invoice.payload,
      currency: 'XTR',
      // One line, whole Stars. Telegram rejects a decimal and there is no such thing as half.
      prices: [{ label: clamp(invoice.title, 32), amount: Number(invoice.stars) }],
    });
  }

  /** The bot a delivery claims to be from, and the secret it must have presented. */
  async forDelivery(botId: string, presentedSecret: string | undefined) {
    const [row] = await this.db
      .select()
      .from(telegramBots)
      .where(and(eq(telegramBots.botId, botId)))
      .limit(1);
    if (!row) return null;
    /**
     * The header is the whole of this endpoint's authentication.
     *
     * It is a public URL taking unauthenticated POSTs, so without this anyone who guessed a
     * bot id could report a payment. Compared plainly rather than in constant time on purpose
     * — it is a 192-bit random string, and there is no oracle here to time against, because a
     * mismatch and an unknown bot return the same nothing.
     */
    if (!presentedSecret || presentedSecret !== row.webhookSecret) return null;
    return row;
  }

  /** The token for a row already fetched, so callers never hold the sealed form. */
  tokenFor(row: { readonly id: string; readonly tokenSealed: string }): string {
    return this.secrets.open(row.tokenSealed, row.id);
  }

  async noteDelivery(id: string): Promise<void> {
    await this.db.update(telegramBots).set({ lastUpdateAt: new Date() }).where(eq(telegramBots.id, id));
  }

  answer(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    return this.transport.call(token, method, body);
  }
}

/** Telegram enforces its own lengths and refuses the whole call over one long title. */
function clamp(value: string, max: number): string {
  const trimmed = value.trim() || 'Payment';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
