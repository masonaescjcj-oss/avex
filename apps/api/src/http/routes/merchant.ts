import { SUPPORTED_CHAINS, amountAfterFee } from '@avex/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { InvoiceCreationError, resolveMode } from '../../domain/invoice-creation.js';
import { MerchantError } from '../../domain/merchant-service.js';
import { FeePlanError } from '../../domain/fee-plan-service.js';
import { WebhookConfigError } from '../../domain/webhook-service.js';
import {
  UnauthenticatedError,
  requireOrganizationAccess,
  requirePermission,
} from '../principal.js';
import type { AppContext } from '../server.js';

/**
 * The merchant dashboard's own routes: invoices, webhooks, and reporting.
 *
 * Everything here goes through `requireOrganizationAccess` before it touches a query.
 * That is what makes tenancy structural rather than remembered — the only way to
 * obtain an organisation id downstream is to have passed the check, so a handler
 * cannot accidentally read across merchants.
 */

const orgParams = z.object({ orgId: z.string().uuid() });

const invoiceQuery = z.object({
  status: z.enum(['pending', 'confirming', 'paid', 'underpaid', 'overpaid', 'expired']).optional(),
  chain: z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]).optional(),
  reference: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(300).optional(),
});

/**
 * Exactly one amount, matching the asset's pricing mode.
 *
 * Enforced here as well as in `createQuote` so a request carrying both is refused
 * before anything is written, with a message about the request rather than about a
 * quote the caller never asked for.
 */
const createInvoiceBody = z
  .object({
    assetId: z.string().uuid(),
    /** The merchant's own order id. Doubles as the idempotency key — see the route. */
    reference: z.string().trim().min(1).max(200).optional(),
    /** Micro-dollars, for `fiat` and `fixed_rate` pricing. */
    amountFiatMicros: z.coerce.bigint().positive().optional(),
    /** The asset's smallest unit, for `token` pricing. */
    amountToken: z.coerce.bigint().positive().optional(),
    /** How long the payer has. Clamped to between a minute and a day. */
    ttlMs: z.coerce.number().int().positive().optional(),
    /**
     * Test or live. Honoured only for a dashboard session — an API key's mode is the
     * key's own and cannot be overridden from the body. See `resolveMode`.
     */
    mode: z.enum(['test', 'live']).optional(),
    /**
     * Who pays the commission on this invoice. Absent means the merchant's default.
     *
     * `payer` grosses the amount up so the split leaves the merchant the price they
     * asked for. It is disclosed on the hosted checkout as its own line.
     */
    feePayer: z.enum(['merchant', 'payer']).optional(),
  })
  .refine(
    (value) => (value.amountFiatMicros === undefined) !== (value.amountToken === undefined),
    { message: 'Send exactly one of amountFiatMicros or amountToken.' },
  );

/**
 * What a merchant's integration reads back.
 *
 * `feeBps` is included because it is the number a merchant is most likely to want to
 * check, and because the deposit address commits to it — so this is the value that
 * settlement will use, not a rate that might change before then.
 *
 * `amountNet` is returned rather than left to be worked out. It is derivable from
 * `amountDue` and `feeBps`, but a merchant reconciling a settlement against an invoice
 * needs it constantly, and every integration deriving it themselves is another place the
 * rounding could be done the wrong way round.
 */
function serialiseInvoice(invoice: {
  id: string;
  reference: string | null;
  mode: 'test' | 'live';
  chain: string;
  status: string;
  amountDue: string;
  amountPaid: string;
  depositAddress: string;
  memo: string | null;
  feeBps: number;
  feePayer: 'merchant' | 'payer';
  toleranceBps: number;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    id: invoice.id,
    reference: invoice.reference,
    /**
     * Echoed back on every invoice, deliberately near the top.
     *
     * A merchant debugging "why did my webhook fire but no money arrived" needs to see
     * this without looking for it, and an integration that ships with a test key in
     * production needs the answer to be obvious in its own logs.
     */
    mode: invoice.mode,
    chain: invoice.chain,
    status: invoice.status,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    depositAddress: invoice.depositAddress,
    memo: invoice.memo,
    feeBps: invoice.feeBps,
    feePayer: invoice.feePayer,
    /** What reaches the merchant when `amountDue` arrives, after the commission. */
    amountNet: amountAfterFee(BigInt(invoice.amountDue), invoice.feeBps).toString(),
    toleranceBps: invoice.toleranceBps,
    createdAt: invoice.createdAt.toISOString(),
    expiresAt: invoice.expiresAt.toISOString(),
  };
}

const endpointBody = z.object({
  url: z.string().url().max(2000),
  /**
   * At least one event. An endpoint subscribed to nothing receives nothing, which
   * looks identical to a broken integration from the merchant's side.
   */
  events: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
});

export function registerMerchantRoutes(app: FastifyInstance, context: AppContext): void {
  const access = async (request: { params: unknown; principal: unknown }) => {
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    return requireOrganizationAccess(context.db, request.principal as never, orgId);
  };

  // ── invoices ──────────────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/invoices', async (request, reply) => {
    const query = invoiceQuery.parse(request.query);
    const granted = await access(request);
    requirePermission(granted, 'invoice:read');

    return reply.send(
      await context.merchant.listInvoices(granted.organizationId, {
        status: query.status,
        chain: query.chain,
        reference: query.reference,
        from: query.from,
        to: query.to,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  });

  app.get('/v1/organizations/:orgId/invoices/:invoiceId', async (request, reply) => {
    const params = orgParams.extend({ invoiceId: z.string().uuid() }).parse(request.params);
    const granted = await access(request);
    requirePermission(granted, 'invoice:read');

    return reply.send(
      await context.merchant.getInvoice(granted.organizationId, params.invoiceId),
    );
  });

  /**
   * Open an invoice. The one route the whole product exists to serve.
   *
   * `invoice:create` rather than `invoice:read`, and deliberately not gated on
   * `settings:write` — an integration's API key needs to open invoices all day
   * without also being able to change where the money goes.
   */
  app.post('/v1/organizations/:orgId/invoices', async (request, reply) => {
    const body = createInvoiceBody.parse(request.body);
    const granted = await access(request);
    requirePermission(granted, 'invoice:create');

    const result = await context.invoiceCreation.create(
      granted.organizationId,
      {
        assetId: body.assetId,
        reference: body.reference,
        amountFiatMicros: body.amountFiatMicros,
        amountToken: body.amountToken,
        ttlMs: body.ttlMs,
        mode: resolveMode(granted.principal, body.mode),
        feePayer: body.feePayer,
      },
      {
        userId: granted.principal.kind === 'session' ? granted.principal.session.userId : null,
        apiKeyId: granted.principal.kind === 'api_key' ? granted.principal.apiKeyId : null,
        ip: request.ip,
      },
    );

    /**
     * 200 for a repeat, 201 for a new one.
     *
     * A merchant retrying after a timeout gets the same invoice and a status code that
     * says so, rather than a 409 they would have to special-case or a 201 that implies
     * they have just created a second address for the same order.
     */
    return reply.status(result.created ? 201 : 200).send(serialiseInvoice(result.invoice));
  });

  /**
   * Pretend a payment arrived. Test invoices only.
   *
   * This is what makes test mode worth having. Without it a merchant can create a test
   * invoice and then has nothing to do with it — the whole point is to drive their own
   * code all the way through: webhook received, signature verified, order marked paid.
   *
   * Refused on a live invoice, and that refusal is the most important line in this
   * route. A merchant able to mark a live invoice paid could ship goods against money
   * that never arrived; more to the point, so could anyone who stole their API key.
   * There is no flag, no override and no staff equivalent — a live invoice is paid by a
   * chain or not at all.
   */
  app.post('/v1/organizations/:orgId/invoices/:invoiceId/simulate-payment', async (request, reply) => {
    const params = orgParams.extend({ invoiceId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        /**
         * Defaults to the full amount, which is what a merchant testing the happy path
         * wants. A smaller figure produces an underpayment, so the awkward branches can
         * be exercised too — those are the ones integrations get wrong.
         */
        amount: z.coerce.bigint().positive().optional(),
      })
      .parse(request.body ?? {});
    const granted = await access(request);
    requirePermission(granted, 'invoice:create');

    const result = await context.merchant.simulatePayment(
      granted.organizationId,
      params.invoiceId,
      body.amount,
    );

    await context.audit.record({
      organizationId: granted.organizationId,
      userId: granted.principal.kind === 'session' ? granted.principal.session.userId : null,
      apiKeyId: granted.principal.kind === 'api_key' ? granted.principal.apiKeyId : null,
      action: 'invoice.payment_simulated',
      targetType: 'invoice',
      targetId: params.invoiceId,
      metadata: { amount: result.amountPaid, status: result.status },
      ip: request.ip,
    });

    return reply.send(result);
  });

  /**
   * A Telegram Stars payment, reported by the merchant's own bot.
   *
   * `invoice:create` rather than a read permission: this writes a payment. The same key an
   * integration uses to open invoices reports their payment, which keeps a Telegram bot to
   * one credential.
   */
  app.post('/v1/organizations/:orgId/invoices/:invoiceId/telegram-payment', async (request, reply) => {
    const params = orgParams.extend({ invoiceId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        /**
         * Telegram's own `telegram_payment_charge_id`, from `successful_payment`.
         *
         * Required, and the idempotency key. A bot that receives the same update twice —
         * which Telegram does not promise never happens — must not credit twice.
         */
        chargeId: z.string().trim().min(1).max(200),
        /** `total_amount` from the same object. Stars are whole units. */
        amountStars: z.coerce.bigint().positive(),
        /** `invoice_payload`, checked against the invoice when sent. */
        payload: z.string().trim().max(300).optional(),
      })
      .parse(request.body);
    const granted = await access(request);
    requirePermission(granted, 'invoice:create');

    const result = await context.merchant.recordStarsPayment(granted.organizationId, params.invoiceId, {
      chargeId: body.chargeId,
      amountStars: body.amountStars,
      payload: body.payload,
    });

    await context.audit.record({
      organizationId: granted.organizationId,
      userId: granted.principal.kind === 'session' ? granted.principal.session.userId : null,
      apiKeyId: granted.principal.kind === 'api_key' ? granted.principal.apiKeyId : null,
      action: 'invoice.stars_reported',
      targetType: 'invoice',
      targetId: params.invoiceId,
      // The charge id is recorded because it is the only thing tying our row back to
      // Telegram's, and a merchant disputing a figure will be asked for it.
      metadata: {
        chargeId: body.chargeId,
        amountStars: body.amountStars.toString(),
        alreadyRecorded: result.alreadyRecorded,
      },
      ip: request.ip,
    });

    return reply.send(result);
  });

  // ── reporting ─────────────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/reports/volume', async (request, reply) => {
    const query = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .parse(request.query);
    const granted = await access(request);
    requirePermission(granted, 'invoice:read');

    return reply.send(
      await context.merchant.volumeReport(granted.organizationId, {
        from: query.from,
        to: query.to,
      }),
    );
  });

  // ── commission ────────────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/commission', async (request, reply) => {
    const granted = await access(request);
    // `settings:read` rather than a billing-specific permission: everyone who can see
    // the organisation's settings can see what it costs, including a viewer. Hiding the
    // rate from the people who negotiate it serves nobody.
    requirePermission(granted, 'settings:read');

    return reply.send(await context.feePlans.forOrganization(granted.organizationId));
  });

  app.post('/v1/organizations/:orgId/commission/fee-payer', async (request, reply) => {
    const body = z.object({ feePayer: z.enum(['merchant', 'payer']) }).parse(request.body);
    const granted = await access(request);
    /**
     * `settings:write`, not a payout-grade permission.
     *
     * This changes what the merchant's customers are asked to pay, not where any money
     * goes — our cut is the same either way and the destination is unchanged. So it does
     * not need the scheduled-change protection a payout address gets.
     */
    requirePermission(granted, 'settings:write');

    await context.feePlans.setFeePayer(
      granted.organizationId,
      body.feePayer,
      granted.principal.kind === 'session' ? granted.principal.session.userId : null,
    );
    return reply.send({
      status: 'updated',
      feePayer: body.feePayer,
      message:
        body.feePayer === 'payer'
          ? 'New invoices will ask for the commission on top of your price, shown to the ' +
            'payer as its own line. Invoices already issued keep their amounts.'
          : 'New invoices will ask for your price, and the commission comes out of the ' +
            'settlement. Invoices already issued keep their amounts.',
    });
  });

  // ── webhooks ──────────────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/webhook-endpoints', async (request, reply) => {
    const granted = await access(request);
    requirePermission(granted, 'webhook:read');

    return reply.send({
      endpoints: await context.merchant.listWebhookEndpoints(granted.organizationId),
    });
  });

  app.post('/v1/organizations/:orgId/webhook-endpoints', async (request, reply) => {
    const body = endpointBody.parse(request.body);
    const granted = await access(request);
    requirePermission(granted, 'webhook:write');

    const created = await context.webhooks.createEndpoint(
      granted.organizationId,
      body.url,
      body.events,
    );

    await context.audit.record({
      organizationId: granted.organizationId,
      userId: granted.principal.kind === 'session' ? granted.principal.session.userId : null,
      apiKeyId: granted.principal.kind === 'api_key' ? granted.principal.apiKeyId : null,
      action: 'webhook_endpoint.created',
      targetType: 'webhook_endpoint',
      targetId: created.id,
      // The URL and events, never the secret — `redact` would not know to strip it.
      metadata: { url: body.url, events: body.events },
      ip: request.ip,
    });

    return reply.status(201).send({
      id: created.id,
      secret: created.secret,
      message:
        'Store this secret now — it is shown once. Verify every callback with it before ' +
        'acting on the payload.',
    });
  });

  app.post('/v1/organizations/:orgId/webhook-endpoints/:endpointId/disable', async (request, reply) => {
    const params = orgParams.extend({ endpointId: z.string().uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const granted = await access(request);
    requirePermission(granted, 'webhook:write');

    const changed = await context.webhooks.setEndpointEnabled(
      granted.organizationId,
      params.endpointId,
      false,
      body.reason ?? null,
    );
    // 404 rather than 403 on someone else's id: confirming it exists is itself a leak.
    if (!changed) return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.' });

    return reply.send({ status: 'disabled' });
  });

  app.post('/v1/organizations/:orgId/webhook-endpoints/:endpointId/enable', async (request, reply) => {
    const params = orgParams.extend({ endpointId: z.string().uuid() }).parse(request.params);
    const granted = await access(request);
    requirePermission(granted, 'webhook:write');

    const changed = await context.webhooks.setEndpointEnabled(
      granted.organizationId,
      params.endpointId,
      true,
    );
    if (!changed) return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.' });

    return reply.send({ status: 'enabled' });
  });

  app.get('/v1/organizations/:orgId/webhook-deliveries', async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    const granted = await access(request);
    requirePermission(granted, 'webhook:read');

    return reply.send({
      deliveries: await context.merchant.listWebhookDeliveries(granted.organizationId, query.limit),
    });
  });

  app.post('/v1/organizations/:orgId/webhook-deliveries/:deliveryId/replay', async (request, reply) => {
    const params = orgParams.extend({ deliveryId: z.string().uuid() }).parse(request.params);
    const granted = await access(request);
    requirePermission(granted, 'webhook:write');

    const queued = await context.webhooks.replay(granted.organizationId, params.deliveryId);
    if (!queued) {
      return reply.status(404).send({ error: 'not_found', message: 'No such delivery.' });
    }
    return reply.send({ status: 'queued', message: 'Queued for another attempt.' });
  });
}

/**
 * Every creation failure, mapped to a status a client can branch on.
 *
 * The split between 404, 409 and 422 is the useful part. 404 means the thing named does
 * not exist. 409 means fix your configuration first — the request is well formed and
 * would work once the account is set up. 422 means the request itself was wrong.
 * Collapsing them into 400 would make all three look like a bug in the merchant's
 * integration.
 */
export function invoiceCreationErrorResponse(error: InvoiceCreationError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'asset_unknown':
      return { status: 404, body: { error: error.code, message: error.message } };
    case 'asset_disabled':
    case 'asset_unapproved':
    case 'fixed_rate_required':
    case 'fixed_rate_expired':
    case 'no_payout_address':
    case 'chain_unsupported':
      return { status: 409, body: { error: error.code, message: error.message } };
    case 'amount_invalid':
      return { status: 422, body: { error: error.code, message: error.message } };
    case 'price_unavailable':
      // Retryable, and the header says how long to wait rather than leaving a client
      // to guess and hammer us while a source recovers.
      return {
        status: 503,
        body: { error: error.code, message: error.message, retryAfterSeconds: 15 },
      };
    case 'not_configured':
      // Our misconfiguration, not theirs. A 4xx here would send a merchant hunting
      // through their own integration for a missing environment variable of ours.
      return { status: 500, body: { error: error.code, message: error.message } };
  }
}

export function merchantErrorResponse(error: MerchantError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: 'not_found', message: error.message } };
    case 'not_test_mode':
    case 'not_stars':
      // 409 rather than 403: the credential was fine, the object was not.
      return { status: 409, body: { error: error.code, message: error.message } };
    case 'charge_reused':
    case 'payload_mismatch':
      /**
       * 422, not 409.
       *
       * The request itself is wrong — a genuine payment reported against the wrong
       * invoice — and the bot must not retry it unchanged.
       */
      return { status: 422, body: { error: error.code, message: error.message } };
  }
}

export function webhookConfigErrorResponse(error: WebhookConfigError): {
  status: number;
  body: Record<string, unknown>;
} {
  return { status: 400, body: { error: 'invalid_webhook_url', message: error.message } };
}

export function feePlanErrorResponse(error: FeePlanError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: 'not_found', message: error.message } };
    // A rate outside 0-500bps. 422 rather than 400: the request parsed, and what is
    // wrong with it is the value, not the shape.
    case 'fee_out_of_range':
      return { status: 422, body: { error: error.code, message: error.message } };
  }
}
