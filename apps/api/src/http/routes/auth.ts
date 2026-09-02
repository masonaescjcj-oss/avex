import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../server.js';
import { EmailAlreadyRegisteredError } from '../../domain/auth-service.js';
import { AUTH_ATTEMPT_LIMIT, AUTH_ATTEMPT_WINDOW_MS, RateLimiter } from '../rate-limit.js';
import { MfaIncompleteError, UnauthenticatedError } from '../principal.js';

const signupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  organizationName: z.string().min(1).max(120),
});

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const codeBody = z.object({ code: z.string().min(6).max(24) });

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  // Each attempt here is a guess at a secret, so these endpoints get a much
  // tighter budget than the global limit.
  const attempts = new RateLimiter(AUTH_ATTEMPT_LIMIT, AUTH_ATTEMPT_WINDOW_MS);
  const pruner = setInterval(() => attempts.prune(), 60_000);
  pruner.unref();

  app.post('/v1/auth/signup', async (request, reply) => {
    const body = signupBody.parse(request.body);

    try {
      const result = await context.auth.signup(
        body.email,
        body.password,
        body.organizationName,
        { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );

      // The token travels by email. Returning it over the API would defeat the
      // purpose of verifying the address at all.
      await context.mailer.sendEmailVerification(body.email, result.emailVerificationToken);

      return reply.status(201).send({
        userId: result.userId,
        organizationId: result.organizationId,
        emailVerificationRequired: true,
      });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        // Deliberately the same shape as success: a signup form must not become an
        // oracle for which addresses have accounts.
        await context.mailer.sendEmailAlreadyRegisteredNotice(body.email);
        return reply.status(201).send({ emailVerificationRequired: true });
      }
      throw error;
    }
  });

  app.post('/v1/auth/verify-email', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(request.body);
    const verified = await context.auth.verifyEmail(token, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return verified
      ? reply.send({ verified: true })
      : reply.status(400).send({
          error: 'invalid_token',
          message: 'This verification link is invalid or has expired. Request a new one.',
        });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const body = loginBody.parse(request.body);

    // Two keys: one per address, one per account. Neither an attacker spraying
    // accounts from one address nor one locking out a victim from many addresses
    // gets an easy path.
    for (const key of [`ip:${request.ip}`, `email:${body.email.toLowerCase()}`]) {
      const decision = attempts.check(key);
      if (!decision.allowed) {
        return reply
          .status(429)
          .header('retry-after', decision.retryAfterSeconds)
          .send({
            error: 'too_many_attempts',
            message: `Too many sign-in attempts. Try again in ${decision.retryAfterSeconds} seconds.`,
          });
      }
    }

    const outcome = await context.auth.login(body.email, body.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    switch (outcome.status) {
      case 'invalid':
        return reply
          .status(401)
          .send({ error: 'invalid_credentials', message: 'That email or password is incorrect.' });
      case 'disabled':
        return reply
          .status(403)
          .send({ error: 'account_disabled', message: 'This account has been disabled.' });
      case 'mfa_required':
        return reply.send({
          status: 'mfa_required',
          token: outcome.sessionToken,
          expiresAt: outcome.expiresAt.toISOString(),
        });
      case 'ok':
        return reply.send({
          status: 'ok',
          token: outcome.sessionToken,
          expiresAt: outcome.expiresAt.toISOString(),
        });
    }
  });

  /**
   * Complete a login's second factor, and also re-prove it to elevate a session
   * before a dangerous action. One endpoint, because it is one operation.
   */
  app.post('/v1/auth/mfa', async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new UnauthenticatedError();

    const decision = attempts.check(`mfa:${principal.session.userId}`);
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', decision.retryAfterSeconds)
        .send({
          error: 'too_many_attempts',
          message: `Too many codes tried. Try again in ${decision.retryAfterSeconds} seconds.`,
        });
    }

    const { code } = codeBody.parse(request.body);
    const satisfied = await context.auth.satisfyMfa(principal.session, code, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return satisfied
      ? reply.send({ status: 'ok' })
      : reply.status(401).send({
          error: 'invalid_code',
          message: 'That code is incorrect or has expired. Check your authenticator and try again.',
        });
  });

  app.post('/v1/auth/totp/enroll', async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new UnauthenticatedError();

    /**
     * Replacing an authenticator that already works takes the one it replaces.
     *
     * A first enrolment cannot ask for a code — there is nothing to prove yet — but a
     * second one can, and must: without it a stolen session is one request away from
     * moving the account's second factor onto the thief's own phone.
     */
    if (principal.session.totpEnabled && !principal.session.mfaComplete) {
      throw new MfaIncompleteError();
    }

    const { secret, uri } = await context.auth.beginTotpEnrollment(
      principal.session.userId,
      principal.session.email,
    );
    // Not active until confirmed, so a half-finished enrolment cannot lock anyone out.
    return reply.send({ secret, uri, status: 'pending_confirmation' });
  });

  app.post('/v1/auth/totp/confirm', async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new UnauthenticatedError();

    const { code } = codeBody.parse(request.body);
    const recoveryCodes = await context.auth.confirmTotpEnrollment(
      principal.session.userId,
      code,
      { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
    );

    if (!recoveryCodes) {
      return reply.status(400).send({
        error: 'invalid_code',
        message: 'That code did not match. Scan the QR code again and enter a fresh code.',
      });
    }

    // Shown exactly once. Only hashes are stored.
    return reply.send({ status: 'enabled', recoveryCodes });
  });

  app.get('/v1/auth/me', async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new UnauthenticatedError();

    if (principal.kind === 'api_key') {
      return reply.send({
        kind: 'api_key',
        organizationId: principal.organizationId,
        mode: principal.mode,
        scopes: principal.scopes,
      });
    }

    const { session } = principal;
    return reply.send({
      kind: 'session',
      userId: session.userId,
      email: session.email,
      emailVerified: session.emailVerified,
      totpEnabled: session.totpEnabled,
      mfaComplete: session.mfaComplete,
    });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new UnauthenticatedError();

    await context.auth.logout(principal.session, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return reply.status(204).send();
  });

  app.post('/v1/auth/sessions/revoke-others', async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.kind !== 'session') throw new UnauthenticatedError();
    if (!principal.session.mfaComplete) throw new MfaIncompleteError();

    await context.auth.revokeOtherSessions(principal.session);
    return reply.status(204).send();
  });
}
