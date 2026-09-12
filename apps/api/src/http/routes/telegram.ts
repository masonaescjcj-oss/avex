import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { TELEGRAM_RAIL } from '../../domain/invoice-creation.js';
import { TelegramBotError } from '../../domain/telegram-bot-service.js';
import { requireOrganizationAccess, requirePermission, UnauthenticatedError } from '../principal.js';
import type { AppContext } from '../server.js';

/**
 * The Telegram side of Stars: the merchant connects a bot, and Telegram posts back to us.
 *
 * Two audiences in one file because they are two halves of one thing. The merchant routes are
 * ordinary authenticated API; the update route below takes unauthenticated POSTs from the open
 * internet and is the only endpoint in this service that does.
 */

const orgParams = z.object({ orgId: z.string().uuid() });

/**
 * A forwarding target, when the merchant has a bot that does more than take payment.
 *
 * https only. We would be posting whatever their users type to this URL, and doing that over
 * plain http would put it on the wire in clear on somebody else's behalf.
 */
const forwardUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((value) => value.startsWith('https://'), 'the forwarding URL must be https')
  .nullable()
  .optional();

export function registerTelegramRoutes(app: FastifyInstance, context: AppContext): void {
  // ── the merchant's side ────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/telegram-bot', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'settings:read');

    const bot = await context.telegram.connected(orgId);
    return reply.send({ bot });
  });

  /**
   * Connect a bot, or replace the one connected.
   *
   * PUT rather than POST: one organisation has one bot, so this is setting a value rather than
   * adding to a collection, and a merchant who pastes a second token means "use this one now".
   */
  app.put('/v1/organizations/:orgId/telegram-bot', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = z
      .object({ token: z.string().trim().min(20).max(200), forwardUrl })
      .parse(request.body);
    if (!request.principal) throw new UnauthenticatedError();
    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'settings:write');

    const bot = await context.telegram.connect(
      orgId,
      { token: body.token, forwardUrl: body.forwardUrl ?? undefined },
      {
        userId: request.principal.kind === 'session' ? request.principal.session.userId : null,
        ip: request.ip,
      },
    );

    return reply.send({
      bot,
      message:
        `@${bot.username} will now send its updates to AVEX. Payments are answered here; ` +
        (bot.forwardUrl
          ? 'everything else is forwarded to your own URL.'
          : 'anything else that bot receives is discarded, so use a bot that does nothing else — ' +
            'or set a forwarding URL.'),
    });
  });

  app.patch('/v1/organizations/:orgId/telegram-bot', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = z.object({ forwardUrl }).parse(request.body);
    if (!request.principal) throw new UnauthenticatedError();
    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'settings:write');

    return reply.send({ bot: await context.telegram.setForwardUrl(orgId, body.forwardUrl ?? null) });
  });

  app.delete('/v1/organizations/:orgId/telegram-bot', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'settings:write');

    const result = await context.telegram.disconnect(orgId, {
      userId: request.principal.kind === 'session' ? request.principal.session.userId : null,
      ip: request.ip,
    });

    return reply.send({
      ...result,
      message: result.webhookRemoved
        ? 'Disconnected, and the bot no longer sends its updates here.'
        : 'Disconnected here. Telegram would not remove the webhook — if that token still ' +
          'works, clear it yourself with deleteWebhook, or the bot will keep posting to a ' +
          'URL that no longer knows it.',
    });
  });

  // ── Telegram's side ────────────────────────────────────────────────────────

  /**
   * Updates, straight from Telegram.
   *
   * The only unauthenticated write in this service, and the rules that make that safe are
   * worth stating in one place.
   *
   * **It answers 200 to everything.** A delivery that fails the secret check, names a bot we
   * do not know, or concerns an invoice that does not exist gets the same empty 200 as one we
   * acted on. Two reasons: an error code is a signal to whoever is probing, and any non-2xx
   * makes Telegram retry the same update for hours.
   *
   * **The secret header is the whole of its authentication.** Telegram echoes back the
   * `secret_token` given at `setWebhook`, 192 bits of randomness per bot, and nothing else
   * about the request is trusted — not the body, not the bot id in the path.
   *
   * **The body is untrusted input.** It is whatever was POSTed to a public URL. Every field
   * read below is read as a claim to be checked against our own rows, never as an instruction:
   * the payload names an invoice, and the invoice says what is owed.
   */
  app.post('/telegram/updates/:botId', async (request, reply) => {
    const params = z.object({ botId: z.string().regex(/^\d{1,20}$/) }).safeParse(request.params);
    if (!params.success) return reply.send({ ok: true });

    const presented = request.headers['x-telegram-bot-api-secret-token'];
    const bot = await context.telegram.forDelivery(
      params.data.botId,
      typeof presented === 'string' ? presented : undefined,
    );
    if (!bot) return reply.send({ ok: true });

    await context.telegram.noteDelivery(bot.id);

    const update = (request.body ?? {}) as TelegramUpdate;

    /**
     * The pre-checkout question, which has ten seconds to be answered or the payment fails.
     *
     * Telegram asks before taking the Stars, and a silence is a refusal. So this is answered
     * from our own rows and nothing else: the payload names an invoice, and that invoice must
     * be one of this merchant's, still open, and for the amount being charged.
     *
     * Approving anything else would be approving a charge we cannot then credit — the payer
     * loses Stars and the order stays unpaid, which is the worst outcome available here.
     */
    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      const verdict = await preCheckoutVerdict(context, bot.organizationId, query);
      try {
        await context.telegram.answer(context.telegram.tokenFor(bot), 'answerPreCheckoutQuery', {
          pre_checkout_query_id: query.id,
          ok: verdict.ok,
          ...(verdict.ok ? {} : { error_message: verdict.reason }),
        });
      } catch {
        // Telegram refused our answer, or we were too slow. Their timeout is the backstop,
        // and the payer is told by Telegram rather than left waiting on a page.
      }
      return reply.send({ ok: true });
    }

    const paid = update.message?.successful_payment;
    if (paid) {
      const invoiceId = invoiceIdFrom(paid.invoice_payload);
      if (invoiceId && typeof paid.telegram_payment_charge_id === 'string') {
        try {
          /**
           * The same call the merchant's own bot makes, on the same idempotency key.
           *
           * Deliberately not a second crediting path. Telegram does not promise an update
           * arrives once, and a merchant may have both integrations pointed at one invoice
           * while they migrate — so the charge id has to be the only thing that decides
           * whether this is a credit or a repeat, wherever the report came from.
           */
          await context.merchant.recordStarsPayment(bot.organizationId, invoiceId, {
            chargeId: paid.telegram_payment_charge_id,
            amountStars: BigInt(paid.total_amount ?? 0),
            payload: paid.invoice_payload,
          });
        } catch (error) {
          /**
           * Logged and swallowed, and this is the one swallow worth arguing for.
           *
           * The Stars are already gone: Telegram charged the payer before sending this. A
           * non-2xx here makes Telegram redeliver the same update for hours, which cannot
           * un-charge anybody and cannot make a duplicate or a mismatched payload become
           * creditable. So it is recorded where an operator will find it, and the merchant
           * is told by the payment simply not appearing.
           */
          request.log.error(
            { err: error, invoiceId, chargeId: paid.telegram_payment_charge_id },
            'a Stars payment could not be credited',
          );
        }
      }
      return reply.send({ ok: true });
    }

    /**
     * Everything else is the merchant's, and is handed straight on.
     *
     * A bot has one webhook. Connecting it here takes over the messages their shop answers,
     * so forwarding is what keeps that from being destructive — we keep the two payment
     * updates, which are ours, and pass the rest through untouched.
     */
    if (bot.forwardUrl) {
      try {
        await fetch(bot.forwardUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // So the merchant's own handler can tell a forwarded update from a direct one.
            'x-avex-forwarded': 'telegram',
          },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        request.log.warn({ err: error, botId: bot.botId }, 'forwarding a Telegram update failed');
      }
    }

    return reply.send({ ok: true });
  });
}

interface TelegramUpdate {
  readonly pre_checkout_query?: {
    readonly id: string;
    readonly currency?: string;
    readonly total_amount?: number;
    readonly invoice_payload?: string;
  };
  readonly message?: {
    readonly successful_payment?: {
      readonly currency?: string;
      readonly total_amount?: number;
      readonly invoice_payload?: string;
      readonly telegram_payment_charge_id?: string;
    };
  };
}

/** The invoice a Telegram payload names, or nothing. The payload is `telegram:<uuid>`. */
function invoiceIdFrom(payload: string | undefined): string | null {
  if (typeof payload !== 'string') return null;
  const prefix = `${TELEGRAM_RAIL}:`;
  if (!payload.startsWith(prefix)) return null;
  const id = payload.slice(prefix.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** Whether to let this charge proceed, decided entirely from our own rows. */
async function preCheckoutVerdict(
  context: AppContext,
  organizationId: string,
  query: { readonly currency?: string; readonly total_amount?: number; readonly invoice_payload?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const invoiceId = invoiceIdFrom(query.invoice_payload);
  if (!invoiceId) {
    return { ok: false, reason: 'This payment link is not one we recognise.' };
  }

  const invoice = await context.merchant.starsInvoiceFor(organizationId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'This payment link is not one we recognise.' };
  }

  if (query.currency !== undefined && query.currency !== 'XTR') {
    return { ok: false, reason: 'This order is payable in Telegram Stars.' };
  }

  if (invoice.status === 'paid' || invoice.status === 'overpaid') {
    return { ok: false, reason: 'This order has already been paid.' };
  }
  if (invoice.status === 'expired') {
    return { ok: false, reason: 'This order has expired. Ask the seller for a new link.' };
  }

  /**
   * The amount has to be the amount owed, exactly.
   *
   * The link we handed out carried it, so a different figure here means the link was edited
   * or reused for another order. Stars are whole units, so there is no rounding to allow for
   * and nothing to be generous about.
   */
  if (BigInt(query.total_amount ?? 0) !== BigInt(invoice.amountDue)) {
    return { ok: false, reason: 'The amount does not match this order.' };
  }

  return { ok: true };
}
