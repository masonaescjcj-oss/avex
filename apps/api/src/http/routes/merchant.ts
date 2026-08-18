import { SUPPORTED_CHAINS } from '@avex/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { InvoiceCreationError } from '../../domain/invoice-creation.js';
import { MerchantError } from '../../domain/merchant-service.js';
import { SubscriptionError } from '../../domain/subscription-service.js';
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
 */
function serialiseInvoice(invoice: {
  id: string;
  reference: string | null;
  chain: string;
  status: string;
  amountDue: string;
  amountPaid: string;
  depositAddress: string;
  memo: string | null;
  feeBps: number;
  toleranceBps: number;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    id: invoice.id,
    reference: invoice.reference,
    chain: invoice.chain,
    status: invoice.status,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    depositAddress: invoice.depositAddress,
    memo: invoice.memo,
    feeBps: invoice.feeBps,
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

  // ── billing ───────────────────────────────────────────────────────────────

  app.get('/v1/organizations/:orgId/subscription', async (request, reply) => {
    const granted = await access(request);
    // `settings:read` rather than a billing-specific permission: everyone who can see
    // the organisation's settings can see what it costs, including a viewer. Hiding the
    // bill from the people who might chase it serves nobody.
    requirePermission(granted, 'settings:read');

    return reply.send(await context.subscriptions.forOrganization(granted.organizationId));
  });

  app.post('/v1/organizations/:orgId/subscription/cancel', async (request, reply) => {
    const granted = await access(request);
    requirePermission(granted, 'settings:write');

    await context.subscriptions.cancelAtPeriodEnd(
      granted.organizationId,
      granted.principal.kind === 'session' ? granted.principal.session.userId : null,
    );
    return reply.send({
      status: 'cancelling',
      message:
        'Scheduled. The gateway keeps working until the end of the period you have paid for.',
    });
  });

  app.post('/v1/organizations/:orgId/subscription/resume', async (request, reply) => {
    const granted = await access(request);
    requirePermission(granted, 'settings:write');

    await context.subscriptions.resume(
      granted.organizationId,
      granted.principal.kind === 'session' ? granted.principal.session.userId : null,
    );
    return reply.send({ status: 'active', message: 'Cancellation withdrawn.' });
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
 * The split between 402, 409 and 422 is the useful part. 402 means pay us and the
 * request will work unchanged. 409 means fix your configuration first. 422 means the
 * request itself was wrong. Collapsing them into 400 would make all three look like
 * a bug in the merchant's integration.
 */
export function invoiceCreationErrorResponse(error: InvoiceCreationError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'billing_blocked':
      return { status: 402, body: { error: error.code, message: error.message } };
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
  }
}

export function webhookConfigErrorResponse(error: WebhookConfigError): {
  status: number;
  body: Record<string, unknown>;
} {
  return { status: 400, body: { error: 'invalid_webhook_url', message: error.message } };
}

export function subscriptionErrorResponse(error: SubscriptionError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: 'not_found', message: error.message } };
    case 'already_paid':
    case 'already_exists':
    case 'no_charge_due':
      return { status: 409, body: { error: error.code, message: error.message } };
  }
}
