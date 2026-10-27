import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AuthEmailVerificationResendRequestSchema,
  AuthEmailVerificationResendResponseSchema,
  AuthEmailVerifyRequestSchema,
  AuthEmailVerifyResponseSchema,
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthSessionResponseSchema,
  AuthSignUpRequestSchema,
  AuthSignUpResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { createVerifiedUserClaims, raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import { APIError } from 'better-auth';

import { runWithAuditRequestId, runWithPasswordResetInviteToken } from './audit-context.js';
import { recordAuthAuditEventSafely, type AuthAuditRecorder } from './audit.js';
import type { InMemoryAuthLimiter } from './auth-limiter.js';
import type { AuthInstance } from './better-auth.js';
import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';
import type { EmailService } from './email-service.js';
import {
  consumeEmailVerification,
  findPendingVerification,
  hashEmailConfirmationToken,
  issueEmailConfirmation
} from './email-verification.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import { createRequireSession } from './session-guard.js';
import { noStore } from '../../plugins/infra/no-store.js';
import { normalizeRateLimitIp } from '../../plugins/infra/rate-limit-ip.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import type { InvitationTokenLookup } from '../invitations/routes.js';

export interface AuthModuleDependencies {
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
  /** Optional B4 adapter; keeping this as a port avoids auth/invitation repository coupling. */
  readonly invitationTokenLookup?: InvitationTokenLookup;
  /** The public sign-up writes the account, its acceptances and its confirmation link (issue #706). */
  readonly database: DatabaseClient;
  readonly emailService: EmailService;
  /** The versions in force, recorded at sign-up exactly like the invitation's new account. */
  readonly legalVersions: { readonly terms: string; readonly privacy: string };
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

const perIpRateLimit = (limit: { readonly max: number; readonly windowMs: number }, docs: DocumentedRouteConfig) => ({
  config: {
    rateLimit: { max: limit.max, timeWindow: limit.windowMs, ...noRateLimitHeaders },
    permission: docs.permission,
    responseStatus: docs.responseStatus,
    schemas: docs.schemas
  }
});

// Declared once per route: the same object is the documentation metadata and the source of the
// schemas the handler validates with.
const loginDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { body: AuthLoginRequestSchema, response: AuthLoginResponseSchema }
} satisfies DocumentedRouteConfig;
const logoutDocs = { permission: null, responseStatus: 204, schemas: {} } satisfies DocumentedRouteConfig;
const sessionDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { response: AuthSessionResponseSchema }
} satisfies DocumentedRouteConfig;
const sessionCheckDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { response: AuthSessionResponseSchema }
} satisfies DocumentedRouteConfig;
const forgotDocs = {
  permission: null,
  responseStatus: 202,
  schemas: { body: AuthPasswordForgotRequestSchema, response: AuthPasswordForgotResponseSchema }
} satisfies DocumentedRouteConfig;
const resetDocs = {
  permission: null,
  responseStatus: 204,
  schemas: { body: AuthPasswordResetRequestSchema }
} satisfies DocumentedRouteConfig;

const signUpDocs = {
  permission: null,
  responseStatus: 202,
  schemas: { body: AuthSignUpRequestSchema, response: AuthSignUpResponseSchema }
} satisfies DocumentedRouteConfig;
const resendVerificationDocs = {
  permission: null,
  responseStatus: 202,
  schemas: { body: AuthEmailVerificationResendRequestSchema, response: AuthEmailVerificationResendResponseSchema }
} satisfies DocumentedRouteConfig;
const verifyEmailDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { body: AuthEmailVerifyRequestSchema, response: AuthEmailVerifyResponseSchema }
} satisfies DocumentedRouteConfig;

const requireAuthenticatedUserId = (request: FastifyRequest): string => {
  if (request.auth === undefined) {
    throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  }
  return request.auth.userId;
};

const unauthenticatedFallback = { statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' } as const;

const invalidCredentials = { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } as const;

/**
 * An unconfirmed account with the right password (2026-10-26 decision on the public sign-up): saying
 * so reveals nothing, because the password was already proved. A wrong password gets
 * `INVALID_CREDENTIALS`, like any other.
 */
const emailNotVerifiedError = {
  statusCode: 403,
  code: 'EMAIL_NOT_VERIFIED',
  message: 'Confirme o seu e-mail para entrar.'
} as const;

/** One answer for a link that is not valid and for a wrong password: neither tells the other apart. */
const verificationFailedError = {
  statusCode: 400,
  code: 'INVALID_LINK_OR_PASSWORD',
  message: 'O link não é mais válido ou a senha está incorreta.'
} as const;

const isEmailNotVerified = (error: unknown): boolean =>
  error instanceof APIError && (error.body as { code?: unknown } | undefined)?.code === 'EMAIL_NOT_VERIFIED';

/**
 * Registers the public auth routes (issue #31 section 6, and the sign-up of issue #706). CSRF/origin checking is handled
 * globally by `registerOriginProtection`; nothing here repeats that check.
 */
export const registerAuthModule = (app: FastifyInstance, dependencies: AuthModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.post('/auth/login', { ...perIpRateLimit(AUTH_RATE_LIMITS.login.ip, loginDocs), onRequest: noStore }, async (request, reply) => {
    const body = routeBody(loginDocs, request);
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
      // Better Auth checks the password before the confirmation, so this code only follows a right one.
      if (isEmailNotVerified(error)) throw new HttpError(emailNotVerifiedError);
      throw toPublicAuthError(error, invalidCredentials);
    }

    // A confirmed account gets its session even with zero contexts and lands on `/comecar`
    // (2026-10-26 decision, which changes rule 3). `requireEmailVerification` already refused an
    // unconfirmed one above; the rule is held here too, so a configuration change cannot hand one a cookie.
    if ((response.user as { emailVerified?: unknown }).emailVerified !== true) {
      await revokeJustCreatedSession(dependencies.auth, response.token, request);
      throw new HttpError(emailNotVerifiedError);
    }

    applyAuthCookies(reply, headers);
    return routeResponse(loginDocs, request, {
      user: { id: response.user.id, name: response.user.name, email: response.user.email }
    });
  });

  app.post('/auth/sign-up', { ...perIpRateLimit(AUTH_RATE_LIMITS.signUp.ip, signUpDocs), onRequest: noStore }, async (request, reply) => {
    const body = routeBody(signUpDocs, request);
    dependencies.limiter.consume('signUp', normalizeRateLimitIp(request.ip), body.email);

    // Hashed on both paths, so a taken address costs the same time as a new one.
    const passwordHash = await (await dependencies.auth.$context).password.hash(body.password);
    const userId = randomUUID();
    // The actor of the transaction is the account being created: `accept_legal_document` records for
    // the actor only, and the account exists by the time it runs.
    const token = await withAuthenticatedUserTransaction(dependencies.database, createVerifiedUserClaims({ userId }), async (transaction) => {
      const inserted = await raw<{ rows: Array<{ id: string }> }>(transaction, `
        insert into auth."user" (id, name, email, "emailVerified") values (?, ?, ?, false)
        on conflict (email) do nothing
        returning id
      `, [userId, body.name, body.email]);
      if (inserted.rows.length === 0) return undefined;
      await raw(transaction, `
        insert into auth."account" (id, "accountId", "providerId", "userId", password, "updatedAt")
        values (?, ?, 'credential', ?, ?, now())
      `, [randomUUID(), userId, userId, passwordHash]);
      await raw(transaction, 'select app_private.accept_legal_document(?, ?)', ['terms', dependencies.legalVersions.terms]);
      await raw(transaction, 'select app_private.accept_legal_document(?, ?)', ['privacy', dependencies.legalVersions.privacy]);
      const issued = await issueEmailConfirmation(transaction, userId);
      if (issued === undefined) throw new Error('A new account must get a confirmation link.');
      return issued;
    });

    // A taken address, confirmed or not, gets a notice and never a link (finding A1 of the review of
    // PR #720), and the response is the same either way.
    if (token !== undefined) dependencies.emailService.sendEmailVerification({ to: body.email, token });
    else dependencies.emailService.sendSignUpWithExistingAccount({ to: body.email });
    return reply.status(202).send(routeResponse(signUpDocs, request, {}));
  });

  app.post('/auth/email/verification/resend', perIpRateLimit(AUTH_RATE_LIMITS.resendVerification.ip, resendVerificationDocs), async (request, reply) => {
    const body = routeBody(resendVerificationDocs, request);
    dependencies.limiter.consume('resendVerification', normalizeRateLimitIp(request.ip), body.email);

    const token = await dependencies.database.transaction(async (transaction) => {
      const pending = await raw<{ rows: Array<{ id: string }> }>(transaction, `
        select id from auth."user" where email = ? and "emailVerified" = false
      `, [body.email]);
      const user = pending.rows[0];
      return user === undefined ? undefined : issueEmailConfirmation(transaction, user.id);
    });
    if (token !== undefined) dependencies.emailService.sendEmailVerification({ to: body.email, token });
    return reply.status(202).send(routeResponse(resendVerificationDocs, request, {}));
  });

  // Finding A1 of the review of PR #720: the link alone confirms nothing, because whoever signed up
  // with someone else's address chose the password. Only a live link plus the account's password
  // confirms the e-mail, and only then is there a session. A wrong password changes nothing and
  // answers exactly like a link that is not valid.
  app.post('/auth/email/verify', { ...perIpRateLimit(AUTH_RATE_LIMITS.verifyEmail.ip, verifyEmailDocs), onRequest: noStore }, async (request, reply) => {
    const body = routeBody(verifyEmailDocs, request);
    const pending = await findPendingVerification(dependencies.database.knex, body.token);
    // The login's counters: guessing the password here costs the same attempts as at `/entrar`.
    dependencies.limiter.consume('login', normalizeRateLimitIp(request.ip), pending?.email ?? `email-confirmation:${hashEmailConfirmationToken(body.token)}`);

    const password = (await dependencies.auth.$context).password;
    const credential = pending === undefined ? undefined : await credentialHashOf(dependencies.database, pending.userId);
    const passwordMatches = credential === undefined
      ? await verifyAgainstDecoy(password, body.password)
      : await password.verify({ hash: credential, password: body.password });
    if (pending === undefined || credential === undefined || !passwordMatches) throw new HttpError(verificationFailedError);

    const confirmed = await dependencies.database.transaction((transaction) =>
      consumeEmailVerification(transaction, body.token, credential));
    if (!confirmed) throw new HttpError(verificationFailedError);

    let headers: Headers;
    let response: { readonly user: { readonly id: string; readonly name: string; readonly email: string } };
    try {
      ({ headers, response } = await dependencies.auth.api.signInEmail({
        body: { email: pending.email, password: body.password },
        headers: toAuthHeaders(request),
        returnHeaders: true
      }));
    } catch {
      // The e-mail is already confirmed; the person can still sign in at `/entrar`.
      throw new HttpError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
    applyAuthCookies(reply, headers);
    return routeResponse(verifyEmailDocs, request, {
      user: { id: response.user.id, name: response.user.name, email: response.user.email }
    });
  });

  app.post('/auth/logout', { preHandler: requireSession, config: logoutDocs }, async (request, reply) => {
    try {
      const { headers } = await dependencies.auth.api.signOut({ headers: toAuthHeaders(request), returnHeaders: true });
      applyAuthCookies(reply, headers);
    } catch (error) {
      throw toPublicAuthError(error, unauthenticatedFallback);
    }
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: requireSession, config: logoutDocs }, async (request, reply) => {
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

  app.get('/auth/session', { onRequest: noStore, preHandler: requireSession, config: sessionDocs }, async (request) => {
    // The `requireSession` preHandler above already called Better Auth's `getSession` once
    // (with `returnHeaders: true`, so a renewed cookie was already applied to the reply, M1) and
    // populated `request.auth`; a second `getSession` call here would be redundant and would
    // discard the renewed cookie the guard already resolved.
    if (request.auth === undefined) throw new HttpError(unauthenticatedFallback);
    return routeResponse(sessionDocs, request, {
      user: request.auth.user,
      session: { expiresAt: request.auth.expiresAt }
    });
  });

  // The periodic check of an open tab (#411): same answer as `/auth/session`, but it never renews the
  // session, so a forgotten tab does not keep it alive past the 7 days without use.
  app.get('/auth/session/check', {
    onRequest: noStore,
    preHandler: createRequireSession({ auth: dependencies.auth }, { renew: false }),
    config: sessionCheckDocs
  }, async (request) => {
    if (request.auth === undefined) throw new HttpError(unauthenticatedFallback);
    return routeResponse(sessionCheckDocs, request, {
      user: request.auth.user,
      session: { expiresAt: request.auth.expiresAt }
    });
  });

  app.post('/auth/password/forgot', perIpRateLimit(AUTH_RATE_LIMITS.forgot.ip, forgotDocs), async (request, reply) => {
    const body = routeBody(forgotDocs, request);
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

    return reply.status(202).send(routeResponse(forgotDocs, request, {}));
  });

  app.post('/auth/password/reset', { ...perIpRateLimit(AUTH_RATE_LIMITS.reset.ip, resetDocs), onRequest: noStore }, async (request, reply) => {
    const body = routeBody(resetDocs, request);
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

    // No session is created: the reset ended every one, and the person signs in again with the new
    // password (2026-10-16 decision), so the invitation continues through the login, not here.
    return reply.status(204).send();
  });
};

const credentialHashOf = async (database: DatabaseClient, userId: string): Promise<string | undefined> => {
  const result = await raw<{ rows: Array<{ password: string | null }> }>(database.knex, `
    select password from auth.account where "userId" = ? and "providerId" = 'credential' limit 1
  `, [userId]);
  return result.rows[0]?.password ?? undefined;
};

type PasswordHasher = Awaited<AuthInstance['$context']>['password'];

let decoyHash: Promise<string> | undefined;

/** A link that resolves to no account still pays for one password check, so the time tells nothing. */
const verifyAgainstDecoy = async (password: PasswordHasher, candidate: string): Promise<false> => {
  decoyHash ??= password.hash(randomUUID());
  await password.verify({ hash: await decoyHash, password: candidate });
  return false;
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
 * Deletes the session `signInEmail` just created for a login of an account that is not confirmed,
 * via the same `internalAdapter.deleteSession` Better Auth's own
 * `revoke-session` endpoint uses. Never throws: the client already gets `EMAIL_NOT_VERIFIED`
 * either way, and a failure here must not replace or mask that response with an unrelated 500.
 */
const revokeJustCreatedSession = async (auth: AuthInstance, token: string, request: FastifyRequest): Promise<void> => {
  try {
    const context = await auth.$context;
    await context.internalAdapter.deleteSession(token);
  } catch (error) {
    request.log.error({
      operation: 'auth.login_unverified_revoke',
      status: 'failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'LOGIN_UNVERIFIED_SESSION_REVOKE_FAILED' }
    }, 'Failed to revoke the session created for a login of an unconfirmed account');
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
