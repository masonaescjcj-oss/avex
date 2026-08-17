import { PriceUnavailableError, type PriceService } from '@avex/core';

import { AssetConfigError } from '../domain/asset-service.js';
import type { AssetService } from '../domain/asset-service.js';
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
import { registerAssetRoutes } from './routes/assets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerPriceRoutes } from './routes/prices.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook. Null on anonymous requests. */
    principal: Principal | null;
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
  /** Aggregation minimum, so coverage gaps can be reported as such. */
  readonly minPriceSources: number;
}

/** Routes reachable without credentials. Everything else needs a principal. */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'POST /v1/auth/signup',
  'POST /v1/auth/login',
  'POST /v1/auth/verify-email',
]);

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
    request.principal = await resolvePrincipal(
      context.db,
      context.auth,
      request.headers.authorization,
    );

    const route = `${request.method} ${request.routeOptions.url ?? request.url}`;
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

  return app;
}
