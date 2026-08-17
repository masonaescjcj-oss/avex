import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AdminError } from '../../domain/admin-service.js';
import { StaffAuthError } from '../../domain/staff-auth.js';
import { STAFF_ROLES } from '../../domain/staff-rbac.js';
import { staffPermissionsFor } from '../../domain/staff-rbac.js';
import type { StaffRole } from '../../domain/staff-rbac.js';
import { requireStaffPermission } from '../staff-principal.js';
import { StaffUnauthenticatedError } from '../staff-principal.js';
import type { AppContext } from '../server.js';

/**
 * The admin panel's API, under `/admin` rather than `/v1`.
 *
 * A separate prefix rather than a separate app, for now. What actually protects
 * these routes is that they resolve a staff session and nothing else: a merchant
 * token or API key reaching one of them fails at authentication, not at
 * authorization. When the panel gets its own origin these routes move behind it
 * unchanged.
 *
 * Everything below reads `request.staff`, which the server's hook has already
 * resolved. Handlers never resolve credentials themselves — that would be a second
 * path to authentication, and two paths is one too many.
 */

const orgParams = z.object({ orgId: z.string().uuid() });
const staffParams = z.object({ staffId: z.string().uuid() });

const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  filter: z.enum(['all', 'active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const suspendBody = z.object({
  /**
   * A reason is required and has a floor, because it is shown to the merchant when
   * they are refused. "abuse" tells them nothing and generates a support ticket
   * that a sentence here would have prevented.
   */
  reason: z.string().trim().min(10).max(500),
});

const reinstateBody = z.object({
  note: z.string().trim().max(500).optional(),
});

const auditQuery = z.object({
  organizationId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().trim().max(120).optional(),
  targetId: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
});

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(400),
});

const completeBody = z.object({
  challengeToken: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(10),
});

const createStaffBody = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(14).max(400),
  role: z.enum(STAFF_ROLES as unknown as [StaffRole, ...StaffRole[]]),
});

const disableStaffBody = z.object({
  reason: z.string().trim().min(5).max(500),
});

export function registerAdminRoutes(app: FastifyInstance, context: AppContext): void {
  const requestContext = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });

  // ── authentication ────────────────────────────────────────────────────────

  app.post('/admin/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);
    const outcome = await context.staffAuth.login(
      body.email,
      body.password,
      requestContext(request),
    );

    if (outcome.status === 'invalid') {
      // One message for a wrong password and for an unknown email. Distinguishing
      // them turns this endpoint into a way to enumerate who works here.
      return reply
        .status(401)
        .send({ error: 'invalid_credentials', message: 'Those details are not correct.' });
    }

    if (outcome.status === 'disabled') {
      return reply.status(403).send({
        error: 'account_disabled',
        message: outcome.reason ?? 'This staff account has been disabled.',
      });
    }

    if (outcome.status === 'enrollment_required') {
      return reply.status(200).send({
        status: 'enrollment_required',
        challengeToken: outcome.challengeToken,
        totpSecret: outcome.totpSecret,
        totpUri: outcome.totpUri,
        message:
          'Add this to your authenticator app, then send the code to finish signing in. ' +
          'Staff accounts cannot be used without one.',
      });
    }

    return reply.status(200).send({
      status: 'mfa_required',
      challengeToken: outcome.challengeToken,
      message: 'Enter the code from your authenticator app.',
    });
  });

  app.post('/admin/auth/complete', async (request, reply) => {
    const body = completeBody.parse(request.body);
    const outcome = await context.staffAuth.completeLogin(
      body.challengeToken,
      body.code,
      requestContext(request),
    );

    if (outcome.status === 'invalid') {
      return reply
        .status(401)
        .send({ error: 'invalid_code', message: 'That code is not correct or has expired.' });
    }
    if (outcome.status === 'disabled') {
      return reply.status(403).send({
        error: 'account_disabled',
        message: outcome.reason ?? 'This staff account has been disabled.',
      });
    }
    if (outcome.status !== 'ok') {
      return reply
        .status(401)
        .send({ error: 'invalid_code', message: 'That sign-in attempt is no longer valid.' });
    }

    return reply.status(200).send({
      status: 'ok',
      sessionToken: outcome.sessionToken,
      expiresAt: outcome.expiresAt.toISOString(),
    });
  });

  app.post('/admin/auth/reauthenticate', async (request, reply) => {
    const body = z.object({ code: z.string().trim().min(6).max(10) }).parse(request.body);
    if (!request.staff) throw new StaffUnauthenticatedError();

    const ok = await context.staffAuth.reauthenticate(request.staff, body.code);
    if (!ok) {
      return reply
        .status(401)
        .send({ error: 'invalid_code', message: 'That code is not correct.' });
    }
    return reply.send({ status: 'ok' });
  });

  app.post('/admin/auth/sign-out', async (request, reply) => {
    if (!request.staff) throw new StaffUnauthenticatedError();
    await context.staffAuth.signOut(request.staff);
    return reply.send({ status: 'ok' });
  });

  /** Who am I, and what may I do — the panel renders its navigation from this. */
  app.get('/admin/me', async (request, reply) => {
    if (!request.staff) throw new StaffUnauthenticatedError();
    return reply.send({
      staffId: request.staff.staffId,
      email: request.staff.email,
      name: request.staff.name,
      role: request.staff.role,
      permissions: staffPermissionsFor(request.staff.role),
      mfaSatisfiedAt: request.staff.mfaSatisfiedAt?.toISOString() ?? null,
    });
  });

  // ── feature 01: merchants ─────────────────────────────────────────────────

  app.get('/admin/merchants', async (request, reply) => {
    const query = listQuery.parse(request.query);
    // No target id: listing merchants is not an access to any one merchant's data,
    // so it is authorised but not written to the audit trail.
    await requireStaffPermission(context.audit, request.staff, 'merchant:read');

    return reply.send(
      await context.admin.listMerchants({
        search: query.search ?? null,
        filter: query.filter ?? 'all',
        limit: query.limit,
        offset: query.offset,
      }),
    );
  });

  app.get('/admin/merchants/:orgId', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    // Named target: this read is recorded, because it is an access to one
    // merchant's data that someone may later have to account for.
    await requireStaffPermission(context.audit, request.staff, 'merchant:read', {
      targetType: 'organization',
      targetId: orgId,
      context: requestContext(request),
    });

    return reply.send(await context.admin.getMerchant(orgId));
  });

  app.post('/admin/merchants/:orgId/suspend', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = suspendBody.parse(request.body);
    const staff = await requireStaffPermission(context.audit, request.staff, 'merchant:suspend', {
      targetType: 'organization',
      targetId: orgId,
      context: requestContext(request),
    });

    await context.admin.suspendMerchant(staff, orgId, body.reason, requestContext(request));
    return reply.send({
      status: 'suspended',
      message: 'Suspended. New invoices and API calls are refused from now.',
    });
  });

  app.post('/admin/merchants/:orgId/reinstate', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = reinstateBody.parse(request.body);
    const staff = await requireStaffPermission(context.audit, request.staff, 'merchant:suspend', {
      targetType: 'organization',
      targetId: orgId,
      context: requestContext(request),
    });

    await context.admin.reinstateMerchant(
      staff,
      orgId,
      body.note ?? null,
      requestContext(request),
    );
    return reply.send({ status: 'active', message: 'Reinstated.' });
  });

  // ── feature 06: audit log search ──────────────────────────────────────────

  app.get('/admin/audit', async (request, reply) => {
    const query = auditQuery.parse(request.query);
    await requireStaffPermission(context.audit, request.staff, 'audit:read');

    return reply.send(
      await context.admin.searchAudit({
        organizationId: query.organizationId ?? null,
        staffId: query.staffId ?? null,
        userId: query.userId ?? null,
        actionPrefix: query.action ?? null,
        targetId: query.targetId ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        limit: query.limit,
        cursor: query.cursor ?? null,
      }),
    );
  });

  // ── staff administration ──────────────────────────────────────────────────

  app.post('/admin/staff', async (request, reply) => {
    const body = createStaffBody.parse(request.body);
    // `staff:write` is elevation-gated: creating an account is quiet and durable,
    // so it needs the authenticator proven again within the last two minutes.
    const staff = await requireStaffPermission(context.audit, request.staff, 'staff:write', {
      context: requestContext(request),
    });

    const created = await context.staffAuth.createStaff(
      staff,
      body.email,
      body.name,
      body.password,
      body.role,
      requestContext(request),
    );

    return reply.status(201).send({
      staffId: created.staffId,
      // Shown once. The new staff member scans it on first sign-in; we do not keep
      // a way to display it again, because a secret that can be re-read is not one.
      totpSecret: created.totpSecret,
      totpUri: created.totpUri,
      message: 'Account created. Give them the authenticator secret over a trusted channel.',
    });
  });

  app.post('/admin/staff/:staffId/disable', async (request, reply) => {
    const params = staffParams.parse(request.params);
    const body = disableStaffBody.parse(request.body);
    const staff = await requireStaffPermission(context.audit, request.staff, 'staff:write', {
      targetType: 'staff',
      targetId: params.staffId,
      context: requestContext(request),
    });

    await context.staffAuth.disableStaff(
      staff,
      params.staffId,
      body.reason,
      requestContext(request),
    );
    return reply.send({
      status: 'disabled',
      message: 'Account disabled and every session it held revoked.',
    });
  });
}

/** Maps admin service failures onto responses. Kept beside the routes it serves. */
export function adminErrorResponse(error: AdminError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: 'not_found', message: error.message } };
    case 'already_suspended':
    case 'not_suspended':
      return { status: 409, body: { error: error.code, message: error.message } };
  }
}

export function staffAuthErrorResponse(error: StaffAuthError): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (error.code) {
    case 'not_found':
      return { status: 404, body: { error: 'not_found', message: error.message } };
    case 'email_taken':
      return { status: 409, body: { error: 'email_taken', message: error.message } };
    case 'role_too_high':
      return { status: 403, body: { error: 'role_too_high', message: error.message } };
    case 'bootstrap_closed':
      return { status: 409, body: { error: 'bootstrap_closed', message: error.message } };
    case 'weak_password':
      return { status: 400, body: { error: 'weak_password', message: error.message } };
    case 'invalid_challenge':
      return { status: 401, body: { error: 'invalid_challenge', message: error.message } };
  }
}
