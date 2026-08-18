import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { CheckoutError } from '../../domain/checkout-service.js';
import {
  UnauthenticatedError,
  requireOrganizationAccess,
  requirePermission,
} from '../principal.js';
import type { AppContext } from '../server.js';

/**
 * The hosted checkout, in two halves.
 *
 * The merchant half creates and inspects sessions and authenticates normally. The
 * payer half is reachable with no credentials at all, because a payer has none — they
 * have a link, and the link is the capability.
 *
 * That makes the public routes the widest attack surface in the product, so each is
 * written against a specific question: what may a stranger holding this link learn,
 * and what may they change? They may read the amount, the currencies on offer and the
 * address once chosen. They may choose a currency. They may not learn the merchant's
 * payout address, their commission, their other orders, or anything about an id they
 * guessed rather than were given.
 */

const orgParams = z.object({ orgId: z.string().uuid() });
const sessionParams = z.object({ sessionId: z.string().uuid() });

const createBody = z.object({
  amountFiatMicros: z.coerce.bigint().positive(),
  /** The merchant's order id. Doubles as the idempotency key. */
  reference: z.string().trim().min(1).max(200).optional(),
  /** Shown to the payer above the amount. */
  description: z.string().trim().min(1).max(300).optional(),
  successUrl: z.string().url().max(2000).optional(),
  cancelUrl: z.string().url().max(2000).optional(),
  ttlMs: z.coerce.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
});

export function registerCheckoutRoutes(app: FastifyInstance, context: AppContext): void {
  // ── merchant side ─────────────────────────────────────────────────────────

  app.post('/v1/organizations/:orgId/checkouts', async (request, reply) => {
    const body = createBody.parse(request.body);
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    const granted = await requireOrganizationAccess(context.db, request.principal, orgId);
    // The same permission invoices need: a checkout is an invoice the payer has not
    // finished specifying.
    requirePermission(granted, 'invoice:create');

    const result = await context.checkouts.create(
      granted.organizationId,
      {
        amountFiatMicros: body.amountFiatMicros,
        reference: body.reference,
        description: body.description,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        ttlMs: body.ttlMs,
      },
      {
        userId: granted.principal.kind === 'session' ? granted.principal.session.userId : null,
        apiKeyId: granted.principal.kind === 'api_key' ? granted.principal.apiKeyId : null,
      },
    );

    // 200 on a repeat, 201 on a new one — the same convention as invoices, so a client
    // retrying after a timeout can tell which happened.
    return reply.status(result.created ? 201 : 200).send({
      id: result.session.id,
      /** The link to send the payer to. Built from APP_URL so it works per deployment. */
      url: `${context.env.APP_URL}/pay/${result.session.id}`,
      status: result.session.status,
      amountFiatMicros: result.session.amountFiatMicros,
      reference: result.session.reference,
      expiresAt: result.session.expiresAt.toISOString(),
    });
  });

  app.get('/v1/organizations/:orgId/checkouts/:sessionId', async (request, reply) => {
    const params = orgParams.extend({ sessionId: z.string().uuid() }).parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    const granted = await requireOrganizationAccess(context.db, request.principal, params.orgId);
    requirePermission(granted, 'invoice:read');

    const session = await context.checkouts.forMerchant(granted.organizationId, params.sessionId);
    return reply.send({
      ...session,
      amountFiatMicros: session.amountFiatMicros,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post('/v1/organizations/:orgId/checkouts/:sessionId/cancel', async (request, reply) => {
    const params = orgParams.extend({ sessionId: z.string().uuid() }).parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();
    const granted = await requireOrganizationAccess(context.db, request.principal, params.orgId);
    requirePermission(granted, 'invoice:create');

    await context.checkouts.cancel(granted.organizationId, params.sessionId);
    return reply.send({ status: 'cancelled' });
  });

  // ── payer side: no credentials ────────────────────────────────────────────

  /**
   * What the payer's page loads.
   *
   * Deliberately not under `/v1/organizations/...`: nothing here is scoped by a
   * merchant id, because a payer does not know one and should not need to. The session
   * id is the whole of the authorisation, which is why it is a random uuid rather than
   * anything sequential.
   */
  app.get('/pay/:sessionId/state', async (request, reply) => {
    const { sessionId } = sessionParams.parse(request.params);
    /**
     * No caching, at any layer.
     *
     * This response carries a payment status that changes under the reader, and a
     * cached "unpaid" shown to a payer who has just paid is the single most confusing
     * thing this page could do.
     */
    return reply
      .header('cache-control', 'no-store')
      .send(await context.checkouts.publicView(sessionId));
  });

  app.get('/pay/:sessionId/options', async (request, reply) => {
    const { sessionId } = sessionParams.parse(request.params);
    // Priced live, so likewise never cached.
    return reply
      .header('cache-control', 'no-store')
      .send({ options: await context.checkouts.options(sessionId) });
  });

  app.post('/pay/:sessionId/select', async (request, reply) => {
    const { sessionId } = sessionParams.parse(request.params);
    const body = z.object({ assetId: z.string().uuid() }).parse(request.body);

    const result = await context.checkouts.select(sessionId, body.assetId, request.ip);
    return reply.header('cache-control', 'no-store').send({
      payment: result.invoice,
      /** False when the payer re-picked what they already had, so a double-tap is a no-op. */
      changed: result.changed,
    });
  });
}

export function checkoutErrorResponse(error: CheckoutError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: error.code, message: error.message } };
    case 'expired':
    case 'cancelled':
      /**
       * 410 rather than 404: the link was real and is now gone.
       *
       * A payer who followed an expired link needs to know it was genuine so they ask
       * the merchant for a new one, rather than assuming they mistyped it.
       */
      return { status: 410, body: { error: error.code, message: error.message } };
    case 'already_paid':
    case 'locked':
      return { status: 409, body: { error: error.code, message: error.message } };
    case 'no_assets':
      return { status: 409, body: { error: error.code, message: error.message } };
  }
}
