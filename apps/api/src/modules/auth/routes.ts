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
import { z } from 'zod';

import { runWithAuditRequestId, runWithPasswordResetInviteToken } from './audit-context.js';
import { recordAuthAuditEventSafely, type AuthAuditRecorder } from './audit.js';
import type { InMemoryAuthLimiter } from './auth-limiter.js';
import type { AuthInstance } from './better-auth.js';
import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import { createRequireSession } from './session-guard.js';
import { normalizeRateLimitIp } from '../../plugins/infra/rate-limit-ip.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import type { InvitationTokenLookup } from '../invitations/routes.js';

export interface AuthModuleDependencies {
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
  /** Optional B4 adapter; keeping this as a port avoids auth/invitation repository coupling. */
  readonly invitationTokenLookup?: InvitationTokenLookup;
  /**
   * Injected by the contexts module so login never reimplements its context-counting query
   * (issue #68). Counts every agency/client context the given user currently has valid access to.
   */
  readonly countValidContexts: (userId: string) => Promise<number>;
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
 * A correct credential that resolves to zero contexts (2026-09-24 decision in decisions.md): the
 * account exists and the password is right, but there is nothing to enter. Distinct from
 * `INVALID_CREDENTIALS` on purpose, since by this point the caller already proved they know the
 * password — the message says so, instead of repeating the generic invalid-credential text.
 */
const noContextAccessError = {
  statusCode: 403,
  code: 'NO_CONTEXT_ACCESS',
  message: 'Sua conta não tem acesso a nenhum espaço de trabalho. Fale com quem administra a agência para receber um convite.'
} as const;

const authLoginWithInvitationSchema = AuthLoginRequestSchema.extend({
  inviteToken: z.string().min(1).max(2_048).optional()
}).strict();
const authPasswordForgotWithInvitationSchema = AuthPasswordForgotRequestSchema.extend({
  inviteToken: z.string().min(1).max(2_048).optional()
}).strict();
const authPasswordResetWithInvitationSchema = AuthPasswordResetRequestSchema.extend({
  inviteToken: z.string().min(1).max(2_048).optional()
}).strict();
const signedInResetResponseSchema = z.object({ signedIn: z.literal(true) }).strict();

/**
 * Registers the six public auth routes (issue #31 section 6). CSRF/origin checking is handled
 * globally by `registerOriginProtection`; nothing here repeats that check.
 */
export const registerAuthModule = (app: FastifyInstance, dependencies: AuthModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.post('/auth/login', perIpRateLimit(AUTH_RATE_LIMITS.login.ip), async (request, reply) => {
    const body = parseRequest(authLoginWithInvitationSchema, request.body);
    dependencies.limiter.consume('login', normalizeRateLimitIp(request.ip), body.email);

    let headers: Headers;
    let response: { readonly token: string; readonly user: { readonly id: string; readonly name: string; readonly email: string } };
    try {
      ({ headers, response } = await dependencies.auth.api.signInEmail({
        body: { email: body.email, password: body.password },
        headers: toAuthHeaders(request),
        returnHeaders: true
      }));
    } catch (error) {
      throw toPublicAuthError(error, { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' });
    }

    // Credential correct; deny only now, per the 2026-09-24 decision (autenticar primeiro, negar
    // depois). A zero-context account still gets a session when `inviteToken` continues straight
    // into accepting an existing-account invitation addressed to it (2026-09-29 decision) — the
    // invite screen (issue #76) must call `POST /invitations/:token/accept` with that same session
    // before ever calling `resolve`, which ends a still-zero-context session on sight. Otherwise
    // the session Better Auth just created above is revoked before it ever reaches the client: no
    // cookie is ever applied on this path, and no row survives in `auth."session"`.
    const contextCount = await dependencies.countValidContexts(response.user.id);
    if (contextCount === 0 && !(await grantsZeroContextAccessViaInvite(dependencies, body.inviteToken, body.email))) {
      await revokeJustCreatedSession(dependencies.auth, response.token, request);
      throw new HttpError(noContextAccessError);
    }

    applyAuthCookies(reply, headers);
    return parseResponse(AuthLoginResponseSchema, {
      user: { id: response.user.id, name: response.user.name, email: response.user.email }
    });
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
    const body = parseRequest(authPasswordForgotWithInvitationSchema, request.body);
    dependencies.limiter.consume('forgot', normalizeRateLimitIp(request.ip), body.email);

    const invitation = body.inviteToken === undefined || dependencies.invitationTokenLookup === undefined
      ? undefined
      : await dependencies.invitationTokenLookup(body.inviteToken).catch(() => undefined);
    const inviteContinuation = invitation?.valid === true && invitation.email === body.email ? body.inviteToken : undefined;

    // Never awaited past this call's own (fast) DB work: the email itself is fire-and-forget
    // inside EmailService, so the response below never depends on SMTP latency or the account
    // actually existing.
    await runWithPasswordResetInviteToken(inviteContinuation, () => dependencies.auth.api.requestPasswordReset({
      body: { email: body.email },
      headers: toAuthHeaders(request)
    })).catch((error) => {
      request.log.error({
        operation: 'auth.password_forgot',
        status: 'failed',
        error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'PASSWORD_RESET_REQUEST_FAILED' }
      }, 'Password reset request failed');
    });

    return reply.status(202).send(parseResponse(AuthPasswordForgotResponseSchema, {}));
  });

  app.post('/auth/password/reset', perIpRateLimit(AUTH_RATE_LIMITS.reset.ip), async (request, reply) => {
    const body = parseRequest(authPasswordResetWithInvitationSchema, request.body);
    // Looked up non-destructively (before `resetPassword` consumes the same verification row)
    // purely so a B10 recovery below has a user id to act on; a lookup failure never blocks the
    // reset itself.
    const userIdForRecovery = await identifyUserIdForResetToken(dependencies.auth, body.token);
    const resetInviteContinuation = await resolveResetInviteContinuation(dependencies, body.inviteToken, userIdForRecovery);

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

    if (resetInviteContinuation !== undefined) {
      try {
        const context = await dependencies.auth.$context;
        const user = await context.internalAdapter.findUserById(resetInviteContinuation.userId);
        if (user !== null && user !== undefined) {
          const { headers } = await dependencies.auth.api.signInEmail({
            body: { email: user.email, password: body.newPassword },
            headers: toAuthHeaders(request),
            returnHeaders: true
          });
          applyAuthCookies(reply, headers);
          return reply.status(200).send(parseResponse(signedInResetResponseSchema, { signedIn: true }));
        }
      } catch {
        // The password reset itself already succeeded. A missing continuation session must not
        // turn a successful reset into a public error; the normal 204 response remains safe.
      }
    }

    return reply.status(204).send(parseResponse(AuthPasswordResetResponseSchema, undefined));
  });
};

/**
 * Whether a zero-context login may still get a session because it continues straight into
 * accepting an existing-account invitation (2026-09-29 decision, complementing the 2026-09-24
 * "credencial correta sem nenhum contexto não cria sessão"): an account removed from every agency
 * and re-invited has zero contexts until it accepts, and accepting needs a session. Reuses the
 * same `app_private.invitation_by_token_hash` validity check (`invitationTokenLookup`, also used
 * by `password/forgot` and `password/reset` above) the invitations module itself relies on — never
 * re-implemented here: not used, not revoked, not expired, agency active, and client active when
 * the invite is one. An invalid, mismatched-email, or absent token is indistinguishable from one
 * another (B1): none of them ever changes the response the caller sees.
 */
const grantsZeroContextAccessViaInvite = async (
  dependencies: AuthModuleDependencies,
  inviteToken: string | undefined,
  email: string
): Promise<boolean> => {
  if (inviteToken === undefined || dependencies.invitationTokenLookup === undefined) return false;
  const invitation = await dependencies.invitationTokenLookup(inviteToken).catch(() => undefined);
  return invitation?.valid === true && invitation.email === email;
};

/**
 * A reset continuation is enabled only when the invite is still valid and its e-mail belongs to
 * the user identified by Better Auth's verification row. Invalid/mismatched optional tokens are
 * intentionally ignored, preserving the ordinary 204 reset response and avoiding enumeration.
 */
const resolveResetInviteContinuation = async (
  dependencies: AuthModuleDependencies,
  inviteToken: string | undefined,
  userId: string | undefined
): Promise<{ userId: string } | undefined> => {
  if (inviteToken === undefined || userId === undefined || dependencies.invitationTokenLookup === undefined) return undefined;
  const invitation = await dependencies.invitationTokenLookup(inviteToken).catch(() => undefined);
  if (invitation?.valid !== true || invitation.email === undefined) return undefined;

  try {
    const context = await dependencies.auth.$context;
    const user = await context.internalAdapter.findUserById(userId);
    return user?.email === invitation.email ? { userId } : undefined;
  } catch {
    return undefined;
  }
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
 * Deletes the session `signInEmail` just created for a login that turned out to resolve to zero
 * contexts (issue #68), via the same `internalAdapter.deleteSession` Better Auth's own
 * `revoke-session` endpoint uses. Never throws: the client already gets `NO_CONTEXT_ACCESS`
 * either way, and a failure here must not replace or mask that response with an unrelated 500.
 */
const revokeJustCreatedSession = async (auth: AuthInstance, token: string, request: FastifyRequest): Promise<void> => {
  try {
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(token);
  } catch (error) {
    request.log.error({
      operation: 'auth.login_no_context_revoke',
      status: 'failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'LOGIN_NO_CONTEXT_SESSION_REVOKE_FAILED' }
    }, 'Failed to revoke the session created for a login that resolved to zero contexts');
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
