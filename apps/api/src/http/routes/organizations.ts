import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { apiKeys, auditLog, memberships, organizations, users } from '../../db/schema.js';
import { issueApiKey } from '../../auth/tokens.js';
import { PERMISSIONS, ROLES, assignableRoles, can, permissionsFor } from '../../domain/rbac.js';
import type { Permission, Role } from '../../domain/rbac.js';
import {
  UnauthenticatedError,
  requireOrganizationAccess,
  requirePermission,
} from '../principal.js';
import type { AppContext } from '../server.js';

const orgParams = z.object({ orgId: z.string().uuid() });

const createKeyBody = z.object({
  name: z.string().min(1).max(80),
  mode: z.enum(['test', 'live']),
  scopes: z.array(z.enum(PERMISSIONS)).min(1),
});

const inviteBody = z.object({
  email: z.string().email().max(320),
  role: z.enum(ROLES),
});

export function registerOrganizationRoutes(app: FastifyInstance, context: AppContext): void {
  /** Organisations the caller belongs to. The dashboard's entry point. */
  app.get('/v1/organizations', async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    if (principal.kind === 'api_key') {
      const [organization] = await context.db
        .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, principal.organizationId))
        .limit(1);
      return reply.send({ data: organization ? [organization] : [] });
    }

    const rows = await context.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: memberships.role,
        suspended: organizations.suspendedAt,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(eq(memberships.userId, principal.session.userId), isNull(memberships.revokedAt)),
      );

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: row.role,
        suspended: row.suspended !== null,
      })),
    });
  });

  app.get('/v1/organizations/:orgId/members', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'member:read');

    const rows = await context.db
      .select({
        userId: users.id,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
        totpEnabled: users.totpEnabledAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, orgId), isNull(memberships.revokedAt)));

    return reply.send({
      data: rows.map((row) => ({
        userId: row.userId,
        email: row.email,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
        twoFactorEnabled: row.totpEnabled !== null,
      })),
    });
  });

  app.post('/v1/organizations/:orgId/members', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = inviteBody.parse(request.body);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'member:invite');

    // Nobody may grant a role above their own, or privilege escalation is one
    // invite away.
    if (access.role === null || !assignableRoles(access.role).includes(body.role)) {
      return reply.status(403).send({
        error: 'role_not_assignable',
        message: `You cannot grant the ${body.role} role.`,
      });
    }

    await context.mailer.sendMemberInvite(body.email, orgId, body.role);
    await context.audit.record({
      organizationId: orgId,
      userId: principal.kind === 'session' ? principal.session.userId : null,
      apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      action: 'member.invited',
      targetType: 'email',
      targetId: body.email,
      metadata: { role: body.role },
    });

    return reply.status(202).send({ status: 'invited' });
  });

  app.get('/v1/organizations/:orgId/api-keys', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'apikey:read');

    const rows = await context.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        mode: apiKeys.mode,
        displayPrefix: apiKeys.displayPrefix,
        scopes: apiKeys.scopes,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, orgId))
      .orderBy(desc(apiKeys.createdAt));

    // The key itself is never retrievable after creation — only its prefix.
    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        mode: row.mode,
        prefix: row.displayPrefix,
        scopes: row.scopes,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        revoked: row.revokedAt !== null,
      })),
    });
  });

  app.post('/v1/organizations/:orgId/api-keys', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const body = createKeyBody.parse(request.body);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    // Issuing a key is elevated: it mints a long-lived credential.
    requirePermission(access, 'apikey:write');

    const grantable = grantableScopes(access.role);
    const excessive = body.scopes.filter((scope) => !grantable.includes(scope));
    if (excessive.length > 0) {
      // A key must never be able to do more than the person who created it.
      return reply.status(403).send({
        error: 'scope_exceeds_role',
        message: `Your role cannot grant: ${excessive.join(', ')}.`,
      });
    }

    const key = issueApiKey(body.mode);
    const [created] = await context.db
      .insert(apiKeys)
      .values({
        organizationId: orgId,
        name: body.name,
        mode: key.mode,
        displayPrefix: key.displayPrefix,
        tokenHash: key.hash,
        scopes: [...body.scopes],
        createdByUserId: principal.kind === 'session' ? principal.session.userId : null,
      })
      .returning({ id: apiKeys.id });

    await context.audit.record({
      organizationId: orgId,
      userId: principal.kind === 'session' ? principal.session.userId : null,
      apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: created!.id,
      metadata: { name: body.name, mode: body.mode, scopes: body.scopes },
    });

    return reply.status(201).send({
      id: created!.id,
      // The only time the caller ever sees this value.
      key: key.token,
      prefix: key.displayPrefix,
      mode: key.mode,
      scopes: body.scopes,
    });
  });

  app.delete('/v1/organizations/:orgId/api-keys/:keyId', async (request, reply) => {
    const { orgId, keyId } = orgParams
      .extend({ keyId: z.string().uuid() })
      .parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'apikey:write');

    // Scoped by organisation as well as id, so a key id from another tenant
    // cannot be revoked by guessing it.
    const revoked = await context.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, orgId), isNull(apiKeys.revokedAt)),
      )
      .returning({ id: apiKeys.id });

    if (revoked.length === 0) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: 'No active key with that id.' });
    }

    await context.audit.record({
      organizationId: orgId,
      userId: principal.kind === 'session' ? principal.session.userId : null,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: keyId,
    });

    return reply.status(204).send();
  });

  app.get('/v1/organizations/:orgId/audit-log', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'audit:read');

    const rows = await context.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.organizationId, orgId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    return reply.send({
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorUserId: row.actorUserId,
        actorApiKeyId: row.actorApiKeyId,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
        ip: row.ip,
        at: row.createdAt.toISOString(),
      })),
    });
  });
}

/**
 * Scopes a role may grant to a key.
 *
 * Elevation-gated permissions are excluded entirely: elevation means proving
 * possession of an authenticator, which a headless key can never do, so granting
 * it would silently create a credential that bypasses the requirement.
 */
export function grantableScopes(role: Role | null): readonly Permission[] {
  if (role === null) return [];
  return permissionsFor(role).filter(
    (permission) => can(role, permission) && !ELEVATION_ONLY.has(permission),
  );
}

const ELEVATION_ONLY: ReadonlySet<Permission> = new Set<Permission>([
  'payout_address:write',
  'apikey:write',
  'member:role_change',
  'member:remove',
  'org:delete',
]);
