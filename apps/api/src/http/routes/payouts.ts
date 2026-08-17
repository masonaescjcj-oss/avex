import { SUPPORTED_CHAINS } from '@avex/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PayoutAddressError } from '../../domain/payout-service.js';
import {
  UnauthenticatedError,
  requireOrganizationAccess,
  requirePermission,
} from '../principal.js';
import type { AppContext } from '../server.js';

const orgParams = z.object({ orgId: z.string().uuid() });

const setBody = z.object({
  chain: z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]),
  address: z.string().min(1).max(120),
});

export function registerPayoutRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/v1/organizations/:orgId/payout-addresses', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    if (!request.principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'payout_address:read');

    return reply.send(await context.payouts.list(orgId));
  });

  /**
   * Set or replace a payout address.
   *
   * `payout_address:write` is owner-only and elevation-gated, so this requires
   * both the highest role and a second factor proven within the last few minutes.
   * Even then, a replacement is scheduled rather than applied.
   */
  app.post('/v1/organizations/:orgId/payout-addresses', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = setBody.parse(request.body);
    if (!request.principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, request.principal, orgId);
    requirePermission(access, 'payout_address:write');

    const userId =
      request.principal.kind === 'session' ? request.principal.session.userId : null;

    const outcome = await context.payouts.requestChange(
      orgId,
      body.chain as (typeof SUPPORTED_CHAINS)[number],
      body.address,
      { userId: userId!, ip: request.ip },
    );

    if (outcome.status === 'active') {
      return reply.status(201).send({
        status: 'active',
        address: outcome.address,
        message: 'Payout address set. Settlements for this chain will go here.',
      });
    }

    // 202: accepted, not done. Saying otherwise would hide the whole point.
    return reply.status(202).send({
      status: 'pending',
      address: outcome.address,
      effectiveAt: outcome.effectiveAt?.toISOString(),
      pendingChangeId: outcome.pendingChangeId,
      message:
        'Change scheduled. It takes effect in 24 hours and everyone in your ' +
        'organization has been emailed. Cancel it any time before then.',
    });
  });

  /**
   * Cancel a scheduled change.
   *
   * Only `payout_address:read` is required, so any member can stop one. The delay
   * is worth having only if whoever reads the email can act on it — and a
   * compromised owner account must not be the sole party able to intervene.
   */
  app.delete(
    '/v1/organizations/:orgId/payout-addresses/pending/:changeId',
    async (request, reply) => {
      const { orgId, changeId } = orgParams
        .extend({ changeId: z.string().uuid() })
        .parse(request.params);
      if (!request.principal) throw new UnauthenticatedError();

      const access = await requireOrganizationAccess(context.db, request.principal, orgId);
      requirePermission(access, 'payout_address:read');

      const userId =
        request.principal.kind === 'session' ? request.principal.session.userId : null;

      await context.payouts.cancelChange(orgId, changeId, { userId: userId!, ip: request.ip });
      return reply.status(204).send();
    },
  );
}

export function payoutErrorResponse(error: PayoutAddressError): {
  status: number;
  body: Record<string, unknown>;
} {
  const status =
    error.code === 'not_found'
      ? 404
      : error.code === 'change_already_pending'
        ? 409
        : 400;
  return { status, body: { error: error.code, message: error.message } };
}
