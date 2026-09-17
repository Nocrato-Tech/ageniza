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

import { runWithAuditRequestId } from './audit-context.js';
import type { AuthAuditRecorder } from './audit.js';
import type { InMemoryAuthLimiter } from './auth-limiter.js';
import type { AuthInstance } from './better-auth.js';
import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import { createRequireSession } from './session-guard.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';

export interface AuthModuleDependencies {
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
}

const perIpRateLimit = (limit: { readonly max: number; readonly windowMs: number }) => ({
  config: { rateLimit: { max: limit.max, timeWindow: limit.windowMs } }
});

const requireAuthenticatedUserId = (request: FastifyRequest): string => {
  if (request.auth === undefined) {
    throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  }
  return request.auth.userId;
};

/**
 * Registers the six public auth routes (issue #31 section 6). CSRF/origin checking is handled
 * globally by `registerOriginProtection`; nothing here repeats that check.
 */
export const registerAuthModule = (app: FastifyInstance, dependencies: AuthModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.post('/auth/login', perIpRateLimit(AUTH_RATE_LIMITS.login.ip), async (request, reply) => {
    const body = parseRequest(AuthLoginRequestSchema, request.body);
    dependencies.limiter.consume('login', request.ip, body.email);

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
    const { headers } = await dependencies.auth.api.signOut({ headers: toAuthHeaders(request), returnHeaders: true });
    applyAuthCookies(reply, headers);
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireAuthenticatedUserId(request);
    await dependencies.auth.api.revokeSessions({ headers: toAuthHeaders(request) });
    await dependencies.auditRecorder.record({ action: 'auth.logout_all', actorUserId: userId, requestId: request.id });
    return reply.status(204).send();
  });

  app.get('/auth/session', { preHandler: requireSession }, async (request) => {
    const result = await dependencies.auth.api.getSession({ headers: toAuthHeaders(request) });
    if (result === null) {
      throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
    }
    return parseResponse(AuthSessionResponseSchema, {
      user: { id: result.user.id, name: result.user.name, email: result.user.email },
      session: { expiresAt: new Date(result.session.expiresAt).toISOString() }
    });
  });

  app.post('/auth/password/forgot', perIpRateLimit(AUTH_RATE_LIMITS.forgot.ip), async (request, reply) => {
    const body = parseRequest(AuthPasswordForgotRequestSchema, request.body);
    dependencies.limiter.consume('forgot', request.ip, body.email);

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

    try {
      await runWithAuditRequestId(request.id, () => dependencies.auth.api.resetPassword({
        body: { token: body.token, newPassword: body.newPassword },
        headers: toAuthHeaders(request)
      }));
    } catch (error) {
      throw toPublicAuthError(error, { statusCode: 400, code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
    }

    return reply.status(204).send(parseResponse(AuthPasswordResetResponseSchema, undefined));
  });
};
