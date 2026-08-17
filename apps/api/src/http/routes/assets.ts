import { SUPPORTED_CHAINS } from '@avex/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AssetConfigError } from '../../domain/asset-service.js';
import {
  UnauthenticatedError,
  requireOrganizationAccess,
  requirePermission,
} from '../principal.js';
import type { AppContext } from '../server.js';

const orgParams = z.object({ orgId: z.string().uuid() });

const submitBody = z.object({
  chain: z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]),
  // Only EVM contracts can be probed automatically; other chains need a different
  // probe and are handled when those adapters land.
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address'),
});

const configureBody = z.object({
  enabled: z.boolean(),
  pricingMode: z.enum(['fiat', 'token', 'fixed_rate']),
  fixedRate: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal, e.g. "0.25"')
    .optional(),
  fixedRateValidUntil: z.coerce.date().optional(),
  spreadBps: z.number().int().min(0).max(9999).optional(),
  toleranceBps: z.number().int().min(0).max(9999).optional(),
});

export function registerAssetRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/v1/organizations/:orgId/assets', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'asset:read');

    return reply.send({ data: await context.assets.listForMerchant(orgId) });
  });

  /**
   * Submit a contract for vetting.
   *
   * Responds 202, not 201: the contract has been probed, but nothing is usable
   * until a reviewer accepts it. Returning a success that reads like "ready" would
   * be the wrong thing to tell a merchant.
   */
  app.post('/v1/organizations/:orgId/assets', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = submitBody.parse(request.body);
    if (!request.principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'asset:write');

    const userId =
      request.principal.kind === 'session' ? request.principal.session.userId : null;

    const { assetId, report } = await context.assets.submitContract(
      orgId,
      body.chain as (typeof SUPPORTED_CHAINS)[number],
      body.contract,
      { userId: userId!, ip: request.ip },
    );

    return reply.status(202).send({
      assetId,
      verdict: report.verdict,
      symbol: report.metadata.symbol,
      decimals: report.metadata.decimals,
      requiresFixedRate: report.requiresFixedRate,
      // Surfaced in full: a merchant is entitled to know what was found, including
      // the checks that could not be run.
      findings: report.findings,
      message:
        report.verdict === 'blocked'
          ? 'This contract cannot be accepted. See the findings.'
          : 'Submitted for review. You will be notified when it is decided.',
    });
  });

  app.put('/v1/organizations/:orgId/assets/:assetId', async (request, reply) => {
    const { orgId, assetId } = orgParams
      .extend({ assetId: z.string().uuid() })
      .parse(request.params);
    const body = configureBody.parse(request.body);
    if (!request.principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'asset:write');

    const userId =
      request.principal.kind === 'session' ? request.principal.session.userId : null;

    await context.assets.configure(
      {
        organizationId: orgId,
        assetId,
        enabled: body.enabled,
        pricingMode: body.pricingMode,
        ...(body.fixedRate === undefined ? {} : { fixedRate: body.fixedRate }),
        ...(body.fixedRateValidUntil === undefined
          ? {}
          : { fixedRateValidUntil: body.fixedRateValidUntil }),
        ...(body.spreadBps === undefined ? {} : { spreadBps: body.spreadBps }),
        ...(body.toleranceBps === undefined ? {} : { toleranceBps: body.toleranceBps }),
      },
      { userId: userId!, ip: request.ip },
    );

    return reply.status(204).send();
  });
}

/** Maps configuration refusals to responses that say what to do about them. */
export function assetErrorResponse(error: AssetConfigError): {
  status: number;
  body: Record<string, unknown>;
} {
  const status =
    error.code === 'not_found' ? 404 : error.code === 'asset_exists' ? 409 : 400;
  return { status, body: { error: error.code, message: error.message } };
}
