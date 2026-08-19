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

const revokeInviteParams = z.object({
  orgId: z.string().uuid(),
  inviteId: z.string().uuid(),
});

const acceptInviteBody = z.object({ token: z.string().min(1).max(400) });

const memberParams = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
});

const roleChangeBody = z.object({ role: z.enum(ROLES) });

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

    /**
     * The invitation is a row, not just a mail.
     *
     * It was a mail alone for a while: the endpoint answered `202 invited`, recorded an
     * audit entry, and left the recipient with a link that pointed at a page nothing
     * served and a token nothing could spend. Nobody could accept, and nothing said so.
     */
    const invite = await context.invites.invite({
      organizationId: orgId,
      email: body.email,
      role: body.role,
      actorRole: access.role,
      actor: {
        userId: principal.kind === 'session' ? principal.session.userId : null,
        apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    const [organization] = await context.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    // The token leaves through the mailer or not at all — never in this response.
    await context.mailer.sendMemberInvite(body.email, {
      organizationName: organization?.name ?? 'an organisation',
      role: body.role,
      token: invite.token,
      expiresAt: invite.expiresAt,
    });

    return reply.status(202).send({
      status: 'invited',
      id: invite.id,
      expiresAt: invite.expiresAt.toISOString(),
      /** How many outstanding invitations for this address it replaced. */
      superseded: invite.supersededCount,
    });
  });

  /**
   * Invitations still waiting.
   *
   * `member:read`, not `member:invite`: seeing who has been asked to join is the same
   * kind of knowledge as seeing who is already in, and a viewer who cannot see the
   * pending list will read the members page as complete when it is not.
   */
  app.get('/v1/organizations/:orgId/invites', async (request, reply) => {
    const { orgId } = orgParams.parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'member:read');

    const pending = await context.invites.pending(orgId);
    const now = Date.now();
    return reply.send({
      data: pending.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedAt: invite.invitedAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
        invitedBy: invite.invitedByEmail,
        /**
         * Stated rather than filtered. "I invited them and nothing happened" is the
         * question this list answers, and one that vanished on its expiry answers it
         * wrongly.
         */
        expired: invite.expiresAt.getTime() <= now,
      })),
    });
  });

  /** Withdraw one. The only defence once the mail has left. */
  app.delete('/v1/organizations/:orgId/invites/:inviteId', async (request, reply) => {
    const { orgId, inviteId } = revokeInviteParams.parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'member:invite');

    const revoked = await context.invites.revoke({
      organizationId: orgId,
      inviteId,
      actor: {
        userId: principal.kind === 'session' ? principal.session.userId : null,
        apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    // Scoped by organisation inside the update, so an id from another organisation is
    // indistinguishable from one that never existed.
    if (!revoked) {
      return reply.status(404).send({
        error: 'invite_not_found',
        message: 'That invitation is not outstanding.',
      });
    }
    return reply.status(204).send();
  });

  /**
   * Change what a member may do.
   *
   * Owner-only and elevation-gated, which `requirePermission` enforces from the permission
   * name alone — this is the operation that can hand somebody the payout address, and a
   * stolen session must not be enough to do it.
   */
  app.patch('/v1/organizations/:orgId/members/:userId', async (request, reply) => {
    const { orgId, userId } = memberParams.parse(request.params);
    const body = roleChangeBody.parse(request.body);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    requirePermission(access, 'member:role_change');

    const outcome = await context.memberships.changeRole({
      organizationId: orgId,
      userId,
      role: body.role,
      actorRole: access.role,
      actor: {
        userId: principal.kind === 'session' ? principal.session.userId : null,
        apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    switch (outcome.status) {
      case 'changed':
        return reply.send({ status: 'changed', from: outcome.from, to: outcome.to });
      case 'unchanged':
        // Not an error and not a write: recording a change that did not happen would put
        // noise in the one log that has to be worth reading during an incident.
        return reply.send({ status: 'unchanged', role: outcome.role });
      case 'not_a_member':
        return reply.status(404).send({
          error: 'not_a_member',
          message: 'That person is not in this organisation.',
        });
      case 'last_owner':
        /**
         * The invariant, with the next step in the message.
         *
         * Owner is the only role that can change where money is sent, so an organisation
         * with no owner is one whose payout address can never be changed again. "You cannot
         * do that" would send somebody hunting for a permission problem.
         */
        return reply.status(409).send({
          error: 'last_owner',
          message:
            'This is the only owner. Make somebody else an owner first, then change this role.',
        });
      case 'role_not_assignable':
        return reply.status(403).send({
          error: 'role_not_assignable',
          message: `You cannot grant the ${outcome.role} role.`,
        });
    }
  });

  /**
   * Remove somebody.
   *
   * Two authorisation paths, because they are two different acts. Removing *somebody else*
   * needs `member:remove`, which is elevated. Leaving yourself needs neither: a viewer has
   * no `member:remove` and would otherwise be unable to leave at all, and somebody who
   * never enrolled an authenticator would be trapped by the elevation requirement.
   *
   * The cost is that a stolen session can remove its own membership. That is the most
   * destructive thing a stolen *viewer* session can do, and it is undone by an admin
   * re-inviting them — which is a better trade than an organisation nobody can leave.
   */
  app.delete('/v1/organizations/:orgId/members/:userId', async (request, reply) => {
    const { orgId, userId } = memberParams.parse(request.params);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    const access = await requireOrganizationAccess(context.db, principal, orgId);
    const isSelf = principal.kind === 'session' && principal.session.userId === userId;
    if (!isSelf) requirePermission(access, 'member:remove');

    const outcome = await context.memberships.remove({
      organizationId: orgId,
      userId,
      actor: {
        userId: principal.kind === 'session' ? principal.session.userId : null,
        apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    switch (outcome.status) {
      case 'removed':
        return reply.send({
          status: 'removed',
          /**
           * Said in the response, because the alternative is an operator assuming access is
           * gone when a key the person created is still live. Keys belong to the
           * organisation, not to the person — revoking them on departure would take
           * production down as a side effect of an HR action.
           */
          apiKeysUnaffected: true,
        });
      case 'not_a_member':
        return reply.status(404).send({
          error: 'not_a_member',
          message: 'That person is not in this organisation.',
        });
      case 'last_owner':
        return reply.status(409).send({
          error: 'last_owner',
          message: isSelf
            ? 'You are the only owner. Make somebody else an owner before you leave.'
            : 'This is the only owner. Make somebody else an owner first.',
        });
    }
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

  /**
   * Accept an invitation.
   *
   * Not under `/v1/organizations/:orgId`, and deliberately: the caller is not a member
   * yet, so there is no organisation they may name. Which organisation this joins is
   * something only the token knows, and the route does not let the caller assert it.
   *
   * A session, never an API key. Joining an organisation is a person's act, the check
   * that makes a forwarded invitation harmless is "is this the invited person", and a
   * key is not a person — it is a credential belonging to an organisation, quite
   * possibly the one doing the inviting.
   */
  app.post('/v1/invites/accept', async (request, reply) => {
    const body = acceptInviteBody.parse(request.body);
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();
    if (principal.kind !== 'session') {
      return reply.status(403).send({
        error: 'session_required',
        message: 'An invitation is accepted by a person signing in, not by an API key.',
      });
    }

    const outcome = await context.invites.accept({
      token: body.token,
      userId: principal.session.userId,
      actor: { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
    });

    switch (outcome.status) {
      case 'accepted':
        return reply.status(201).send({
          status: 'accepted',
          organizationId: outcome.organizationId,
          role: outcome.role,
        });
      case 'already_member':
        /**
         * 200, not an error: nothing went wrong, and the invitation is spent. The role
         * they already had is unchanged — an invitation must not be a quiet path around
         * `member:role_change`, which is elevated and audited for good reason.
         */
        return reply.send({
          status: 'already_member',
          organizationId: outcome.organizationId,
          role: outcome.role,
        });
      case 'wrong_account':
        return reply.status(409).send({
          error: 'wrong_account',
          message: `This invitation was sent to ${outcome.invitedEmail}. Sign in with that address to accept it.`,
        });
      case 'expired':
        return reply.status(410).send({
          error: 'invite_expired',
          message: 'This invitation has expired. Ask for a new one.',
        });
      case 'inviter_unauthorized':
        // The world moved while the mail waited: whoever sent it can no longer grant
        // what it offers.
        return reply.status(409).send({
          error: 'invite_no_longer_valid',
          message:
            'Whoever invited you can no longer grant that role. Ask somebody there to invite you again.',
        });
      case 'invalid':
        return reply.status(404).send({
          error: 'invite_not_found',
          message: 'This invitation is not valid. It may have been withdrawn or already used.',
        });
    }
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
