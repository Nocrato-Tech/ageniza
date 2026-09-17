import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema,
  AuthSessionResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { APIError } from 'better-auth';

import { runWithAuditRequestId } from './audit-context.js';
import { recordAuthAuditEventSafely, type AuthAuditRecorder } from './audit.js';
import type { InMemoryAuthLimiter } from './auth-limiter.js';
import type { AuthInstance } from './better-auth.js';
import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import { createRequireSession } from './session-guard.js';
import { normalizeRateLimitIp } from '../../plugins/infra/rate-limit-ip.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';

export interface AuthModuleDependencies {
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
}

/** No informative headers on any auth 429 (B6): a client must not be able to tell, from the
 * response shape alone, whether a per-IP limit or an in-memory dimension tripped. */
const noRateLimitHeaders = {
  addHeaders: {
    'x-ratelimit-limit': false,
    'x-ratelimit-remaining': false,
    'x-ratelimit-reset': false,
    'retry-after': false
  },
  addHeadersOnExceeding: {
    'x-ratelimit-limit': false,
    'x-ratelimit-remaining': false,
    'x-ratelimit-reset': false
  }
} as const;

const perIpRateLimit = (limit: { readonly max: number; readonly windowMs: number }) => ({
  config: { rateLimit: { max: limit.max, timeWindow: limit.windowMs, ...noRateLimitHeaders } }
});

const requireAuthenticatedUserId = (request: FastifyRequest): string => {
  if (request.auth === undefined) {
    throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  }
  return request.auth.userId;
};

const unauthenticatedFallback = { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' } as const;

/**
 * Registers the six public auth routes (issue #31 section 6). CSRF/origin checking is handled
 * globally by `registerOriginProtection`; nothing here repeats that check.
 */
export const registerAuthModule = (app: FastifyInstance, dependencies: AuthModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.post('/auth/login', perIpRateLimit(AUTH_RATE_LIMITS.login.ip), async (request, reply) => {
    const body = parseRequest(AuthLoginRequestSchema, request.body);
    dependencies.limiter.consume('login', normalizeRateLimitIp(request.ip), body.email);

    try {
      const { headers, response } = await dependencies.auth.api.signInEmail({
        body: { email: body.email, password: body.password },
        headers: toAuthHeaders(request),
        returnHeaders: true
      });
      applyAuthCookies(reply, headers);
      return parseResponse(AuthLoginResponseSchema, {
        user: { id: response.user.id, name: response.user.name, email: response.user.email }
      });
    } catch (error) {
      throw toPublicAuthError(error, { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' });
    }
  });

  app.post('/auth/logout', { preHandler: requireSession }, async (request, reply) => {
    try {
      const { headers } = await dependencies.auth.api.signOut({ headers: toAuthHeaders(request), returnHeaders: true });
      applyAuthCookies(reply, headers);
    } catch (error) {
      throw toPublicAuthError(error, unauthenticatedFallback);
    }
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireAuthenticatedUserId(request);
    try {
      await dependencies.auth.api.revokeSessions({ headers: toAuthHeaders(request) });
    } catch (error) {
      throw toPublicAuthError(error, unauthenticatedFallback);
    }
    // The action above already completed; a failure to audit it never undoes or blocks the
    // response (B9).
    await recordAuthAuditEventSafely(
      dependencies.auditRecorder,
      { action: 'auth.logout_all', actorUserId: userId, requestId: request.id },
      request.log
    );
    return reply.status(204).send();
  });

  app.get('/auth/session', { preHandler: requireSession }, async (request) => {
    // The `requireSession` preHandler above already called Better Auth's `getSession` once
    // (with `returnHeaders: true`, so a renewed cookie was already applied to the reply, M1) and
    // populated `request.auth`; a second `getSession` call here would be redundant and would
    // discard the renewed cookie the guard already resolved.
    if (request.auth === undefined) throw new HttpError(unauthenticatedFallback);
    return parseResponse(AuthSessionResponseSchema, {
      user: request.auth.user,
      session: { expiresAt: request.auth.expiresAt }
    });
  });

  app.post('/auth/password/forgot', perIpRateLimit(AUTH_RATE_LIMITS.forgot.ip), async (request, reply) => {
    const body = parseRequest(AuthPasswordForgotRequestSchema, request.body);
    dependencies.limiter.consume('forgot', normalizeRateLimitIp(request.ip), body.email);

    // Never awaited past this call's own (fast) DB work: the email itself is fire-and-forget
    // inside EmailService, so the response below never depends on SMTP latency or the account
    // actually existing.
    await dependencies.auth.api.requestPasswordReset({
      body: { email: body.email },
      headers: toAuthHeaders(request)
    }).catch((error) => {
      request.log.error({
        operation: 'auth.password_forgot',
        status: 'failed',
        error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'PASSWORD_RESET_REQUEST_FAILED' }
      }, 'Password reset request failed');
    });

    return reply.status(202).send(parseResponse(AuthPasswordForgotResponseSchema, {}));
  });

  app.post('/auth/password/reset', perIpRateLimit(AUTH_RATE_LIMITS.reset.ip), async (request, reply) => {
    const body = parseRequest(AuthPasswordResetRequestSchema, request.body);
    // Looked up non-destructively (before `resetPassword` consumes the same verification row)
    // purely so a B10 recovery below has a user id to act on; a lookup failure never blocks the
    // reset itself.
    const userIdForRecovery = await identifyUserIdForResetToken(dependencies.auth, body.token);

    try {
      await runWithAuditRequestId(request.id, () => dependencies.auth.api.resetPassword({
        body: { token: body.token, newPassword: body.newPassword },
        headers: toAuthHeaders(request)
      }));
    } catch (error) {
      // B10: an unexpected (non-`APIError`) failure part-way through a reset is genuinely
      // ambiguous about whether the password itself was already changed. Best-effort revoke every
      // session for the affected user (when identifiable) so an attacker cannot ride out a partial
      // failure with a still-valid session; the client never sees these details either way.
      if (!(error instanceof APIError)) {
        if (userIdForRecovery !== undefined) {
          await bestEffortRevokeSessionsForUser(dependencies.auth, userIdForRecovery, request);
        } else {
          request.log.error({
            operation: 'auth.password_reset_recovery',
            status: 'failed',
            error: { name: 'UnresolvedUser', code: 'PASSWORD_RESET_RECOVERY_USER_UNKNOWN' }
          }, 'Password reset failed mid-way and the affected user could not be identified for session revocation');
        }
      }
      throw toPublicAuthError(error, { statusCode: 400, code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
    }

    return reply.status(204).send(parseResponse(AuthPasswordResetResponseSchema, undefined));
  });
};

/**
 * Non-destructively looks up the user id behind a password-reset token, using the same
 * `internalAdapter.findVerificationValue` Better Auth's own `resetPassword` endpoint reads from
 * (mirrored here only for B10 recovery, before that endpoint consumes/deletes the row). Returns
 * `undefined` on any failure or when the token does not resolve to a live verification row.
 */
const identifyUserIdForResetToken = async (auth: AuthInstance, token: string): Promise<string | undefined> => {
  try {
    const context = await auth.$context;
    const verification = await context.internalAdapter.findVerificationValue(`reset-password:${token}`);
    return typeof verification?.value === 'string' && verification.value.length > 0 ? verification.value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Revokes every session for a user via the same `internalAdapter.deleteUserSessions` Better
 * Auth's own `resetPassword` endpoint uses for `revokeSessionsOnPasswordReset`. Never throws:
 * this only ever runs alongside an error that is already being propagated to the client (B10),
 * and a failure here must not replace or mask that original error.
 */
const bestEffortRevokeSessionsForUser = async (auth: AuthInstance, userId: string, request: FastifyRequest): Promise<void> => {
  try {
    const context = await auth.$context;
    await context.internalAdapter.deleteUserSessions(userId);
  } catch (error) {
    request.log.error({
      operation: 'auth.password_reset_recovery',
      status: 'failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'PASSWORD_RESET_RECOVERY_FAILED' }
    }, 'Failed to revoke sessions after a mid-way password reset failure');
  }
};
