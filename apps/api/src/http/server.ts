import { PriceUnavailableError, type PriceService } from '@avex/core';

import { AssetConfigError } from '../domain/asset-service.js';
import type { AssetService } from '../domain/asset-service.js';
import { PayoutAddressError } from '../domain/payout-service.js';
import type { PayoutAddressService } from '../domain/payout-service.js';
import { assetErrorResponse } from './routes/assets.js';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import type { Database } from '../db/client.js';
import type { AuditService } from '../domain/audit.js';
import type { AuthService } from '../domain/auth-service.js';
import { ElevationRequiredError, PermissionDeniedError } from '../domain/rbac.js';
import type { Env } from '../env.js';
import type { Mailer } from '../mailer.js';
import {
  MfaIncompleteError,
  NotAMemberError,
  OrganizationSuspendedError,
  ScopeMissingError,
  TwoFactorEnrollmentRequiredError,
  UnauthenticatedError,
  resolvePrincipal,
} from './principal.js';
import type { Principal } from './principal.js';
import { RateLimiter } from './rate-limit.js';
import { AdminError } from '../domain/admin-service.js';
import type { AdminService } from '../domain/admin-service.js';
import { ReconciliationError } from '../domain/reconciliation-service.js';
import type { ReconciliationService } from '../domain/reconciliation-service.js';
import type { SettlementStore } from '../domain/settlement-store.js';
import { MerchantError } from '../domain/merchant-service.js';
import { FeePlanError } from '../domain/fee-plan-service.js';
import type { FeePlanService } from '../domain/fee-plan-service.js';
import type { MerchantService } from '../domain/merchant-service.js';
import { WebhookConfigError } from '../domain/webhook-service.js';
import type { WebhookService } from '../domain/webhook-service.js';
import { StaffAuthError } from '../domain/staff-auth.js';
import { CheckoutError } from '../domain/checkout-service.js';
import type { CheckoutService } from '../domain/checkout-service.js';
import { InvoiceCreationError } from '../domain/invoice-creation.js';
import type { InvoiceCreationService } from '../domain/invoice-creation.js';
import type { StaffAuthService, StaffPrincipal } from '../domain/staff-auth.js';
import {
  StaffElevationRequiredError,
  StaffPermissionDeniedError,
} from '../domain/staff-rbac.js';
import {
  StaffTwoFactorRequiredError,
  StaffUnauthenticatedError,
  resolveStaffPrincipal,
} from './staff-principal.js';
import {
  adminErrorResponse,
  reconciliationErrorResponse,
  registerAdminRoutes,
  staffAuthErrorResponse,
} from './routes/admin.js';
import { registerAssetRoutes } from './routes/assets.js';
import { checkoutErrorResponse, registerCheckoutRoutes } from './routes/checkout.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerPayoutRoutes, payoutErrorResponse } from './routes/payouts.js';
import { registerPriceRoutes } from './routes/prices.js';
import {
  invoiceCreationErrorResponse,
  merchantErrorResponse,
  registerMerchantRoutes,
  feePlanErrorResponse,
  webhookConfigErrorResponse,
} from './routes/merchant.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook. Null on anonymous requests. */
    principal: Principal | null;
    /**
     * Set by the staff authentication hook on `/admin` routes only.
     *
     * Separate from `principal` on purpose: a merchant credential must never be
     * able to satisfy a staff check, and keeping them in different fields means a
     * handler cannot confuse one for the other even by accident.
     */
    staff: StaffPrincipal | null;
  }
}

export interface AppContext {
  readonly env: Env;
  readonly db: Database;
  readonly auth: AuthService;
  readonly audit: AuditService;
  readonly mailer: Mailer;
  readonly prices: PriceService;
  readonly assets: AssetService;
  readonly payouts: PayoutAddressService;
  readonly staffAuth: StaffAuthService;
  readonly admin: AdminService;
  readonly settlements: SettlementStore;
  readonly reconciliation: ReconciliationService;
  readonly merchant: MerchantService;
  readonly webhooks: WebhookService;
  readonly feePlans: FeePlanService;
  readonly invoiceCreation: InvoiceCreationService;
  readonly checkouts: CheckoutService;
  /** Aggregation minimum, so coverage gaps can be reported as such. */
  readonly minPriceSources: number;
}

/** Routes reachable without credentials. Everything else needs a principal. */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'POST /v1/auth/signup',
  'POST /v1/auth/login',
  'POST /v1/auth/verify-email',
  /**
   * The payer-facing checkout. A payer has no account and never will — the link is
   * the capability, which is why the session id is a random uuid.
   *
   * Note what is public and what is not: reading the amount and the currencies, and
   * choosing one. There is no public route that reads a merchant's other orders, and
   * `publicView` is written to return only fields a stranger holding the link may see.
   */
  'GET /pay/:sessionId/state',
  'GET /pay/:sessionId/options',
  'POST /pay/:sessionId/select',
]);

/**
 * Admin routes reachable before a staff session exists.
 *
 * Only the two login steps. Note what is absent: there is no `/admin` route that
 * creates the first account. Bootstrapping is a command-line operation, because an
 * HTTP path that can mint a superadmin is a path an attacker can reach.
 */
const PUBLIC_ADMIN_ROUTES = new Set(['POST /admin/auth/login', 'POST /admin/auth/complete']);

/** Everything below this prefix authenticates as staff, never as a merchant. */
const ADMIN_PREFIX = '/admin';

/** The payer-facing checkout. The only prefix that may be called cross-origin. */
const CHECKOUT_PREFIX = '/pay';

export function buildServer(context: AppContext): FastifyInstance {
  const app = Fastify({
    logger: {
      level: context.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: [
        'req.headers.authorization',
        'req.body.password',
        'req.body.code',
        'req.body.token',
      ],
    },
    // Behind a load balancer, `request.ip` must come from the forwarded header or
    // every client shares one rate-limit bucket.
    trustProxy: context.env.NODE_ENV === 'production',
    bodyLimit: 256 * 1024,
  });

  const globalLimiter = new RateLimiter(context.env.RATE_LIMIT_PER_MINUTE);
  const pruner = setInterval(() => globalLimiter.prune(), 60_000);
  pruner.unref();

  app.decorateRequest('principal', null);
  app.decorateRequest('staff', null);

  /**
   * Cross-origin access, for the payer-facing checkout only.
   *
   * Scoped deliberately. Those routes carry no credentials — the session id in the URL
   * is the whole authorisation — so allowing a browser on another origin to read them
   * gives away nothing it could not get with a plain fetch from a server. The same
   * header on an authenticated route would be a different matter entirely: any page a
   * signed-in merchant visited could then read their invoices using their own session,
   * which is why this never applies outside `/pay`.
   *
   * Credentials are never allowed, so a browser will not attach cookies even if a
   * future deployment sets any.
   */
  app.addHook('onRequest', async (request, reply) => {
    const url = request.routeOptions.url ?? request.url;
    if (!url.startsWith(CHECKOUT_PREFIX)) return;

    const origin = request.headers.origin;
    if (typeof origin !== 'string') return;

    const allowed = context.env.CHECKOUT_ORIGINS.includes(origin.replace(/\/$/, ''));
    if (!allowed) {
      /**
       * An unlisted origin gets no CORS header at all, and the preflight is still
       * answered.
       *
       * Refusing the preflight with a 403 would be indistinguishable, to the page, from
       * the API being down — and the browser blocks the real request either way, so the
       * header's absence is the whole enforcement. Saying less is better here.
       */
      if (request.method === 'OPTIONS') return reply.status(204).send();
      return;
    }

    reply
      .header('access-control-allow-origin', origin)
      // So a cache keyed on the URL alone cannot serve one origin's header to another.
      .header('vary', 'origin')
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '600');

    // The preflight ends here; there is no handler for OPTIONS and none is wanted.
    if (request.method === 'OPTIONS') return reply.status(204).send();
  });

  app.addHook('onRequest', async (request, reply) => {
    const decision = globalLimiter.check(request.ip);
    reply.header('x-ratelimit-remaining', decision.remaining);
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', decision.retryAfterSeconds)
        .send({
          error: 'rate_limited',
          message: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`,
        });
    }
  });

  /**
   * Resolve credentials on every request, then refuse anonymous access to
   * anything not explicitly public.
   *
   * Default-deny is the point: a new route is protected by existing, and a
   * developer has to add it to PUBLIC_ROUTES on purpose to open it up.
   */
  app.addHook('onRequest', async (request) => {
    const url = request.routeOptions.url ?? request.url;
    const route = `${request.method} ${url}`;

    /**
     * Admin routes take the staff path and nothing else.
     *
     * The merchant resolver is not even run for them. If both ran, a route that
     * forgot its staff check would still see a populated `principal` and could act
     * on a merchant credential — so the two credential types are kept from ever
     * being present on the same request.
     */
    if (url.startsWith(ADMIN_PREFIX)) {
      request.staff = await resolveStaffPrincipal(context.staffAuth, request.headers.authorization);
      if (PUBLIC_ADMIN_ROUTES.has(route)) return;
      if (request.staff === null) throw new StaffUnauthenticatedError();
      return;
    }

    request.principal = await resolvePrincipal(
      context.db,
      context.auth,
      request.headers.authorization,
    );

    if (PUBLIC_ROUTES.has(route)) return;
    if (request.principal === null) throw new UnauthenticatedError();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'Some fields are missing or invalid.',
        fields: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof UnauthenticatedError) {
      return reply
        .status(401)
        .send({ error: 'unauthenticated', message: 'Sign in to continue.' });
    }

    if (error instanceof StaffUnauthenticatedError) {
      return reply
        .status(401)
        .send({ error: 'staff_unauthenticated', message: 'Sign in to the admin panel.' });
    }

    if (error instanceof StaffElevationRequiredError) {
      return reply.status(403).send({
        error: 'elevation_required',
        message: 'Confirm with your authenticator app to make this change.',
        permission: error.permission,
      });
    }

    if (error instanceof StaffTwoFactorRequiredError) {
      return reply.status(403).send({
        error: 'elevation_required',
        message: 'Confirm with your authenticator app to make this change.',
        permission: error.permission,
      });
    }

    if (error instanceof StaffPermissionDeniedError) {
      return reply.status(403).send({
        error: 'permission_denied',
        message: 'Your staff role does not allow this action.',
        permission: error.permission,
      });
    }

    if (error instanceof StaffAuthError) {
      const { status, body } = staffAuthErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof AdminError) {
      const { status, body } = adminErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof FeePlanError) {
      const { status, body } = feePlanErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof CheckoutError) {
      const { status, body } = checkoutErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof InvoiceCreationError) {
      const { status, body } = invoiceCreationErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof MerchantError) {
      const { status, body } = merchantErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof WebhookConfigError) {
      const { status, body } = webhookConfigErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof ReconciliationError) {
      const { status, body } = reconciliationErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof MfaIncompleteError) {
      return reply.status(401).send({
        error: 'mfa_required',
        message: 'Enter the code from your authenticator app to continue.',
      });
    }

    if (error instanceof ElevationRequiredError) {
      // Distinct from mfa_required: the session is fully signed in, but this
      // particular action needs the second factor proven again, just now.
      return reply.status(403).send({
        error: 'elevation_required',
        message: 'Confirm with your authenticator app to make this change.',
        permission: error.permission,
      });
    }

    if (error instanceof TwoFactorEnrollmentRequiredError) {
      return reply.status(403).send({
        error: 'two_factor_required',
        message:
          'Set up two-factor authentication before making this change. ' +
          'Open security settings to enroll an authenticator app.',
        permission: error.permission,
      });
    }

    if (error instanceof PermissionDeniedError) {
      return reply.status(403).send({
        error: 'permission_denied',
        message: 'Your role does not allow this action.',
        permission: error.permission,
      });
    }

    if (error instanceof ScopeMissingError) {
      return reply.status(403).send({
        error: 'scope_missing',
        message: 'This API key was not granted that permission.',
        permission: error.permission,
      });
    }

    if (error instanceof NotAMemberError) {
      // Deliberately 404 rather than 403: confirming an organisation exists to a
      // non-member is itself a leak.
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'No such organization.' });
    }

    if (error instanceof OrganizationSuspendedError) {
      return reply.status(403).send({
        error: 'organization_suspended',
        message: error.reason ?? 'This organization is suspended. Contact support.',
      });
    }

    if (error instanceof PayoutAddressError) {
      const { status, body } = payoutErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof AssetConfigError) {
      const { status, body } = assetErrorResponse(error);
      return reply.status(status).send(body);
    }

    if (error instanceof PriceUnavailableError) {
      // Not our fault and not the caller's: the feed cannot be trusted right now.
      // Explicitly 503 so clients retry rather than treating it as a bad request.
      return reply.status(503).send({
        error: 'price_unavailable',
        message: `Pricing for ${error.symbol} is temporarily unavailable. Try again shortly.`,
        reason: error.reason,
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: 'internal_error', message: 'Something went wrong on our side.' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, context);
  registerOrganizationRoutes(app, context);
  registerPriceRoutes(app, context);
  registerAssetRoutes(app, context);
  registerPayoutRoutes(app, context);
  registerMerchantRoutes(app, context);
  registerCheckoutRoutes(app, context);
  registerAdminRoutes(app, context);

  return app;
}
