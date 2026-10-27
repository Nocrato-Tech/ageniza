import { betterAuth } from 'better-auth';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { ApiConfig } from '@ageniza/config/server';
import { captureUnexpectedError, type CoreLogger } from '@ageniza/core';

import { currentAuditRequestId, currentPasswordResetInviteToken } from './audit-context.js';
import { recordAuthAuditEventSafely, type AuthAuditRecorder } from './audit.js';
import type { EmailService } from './email-service.js';
import { AUTH_SESSION_MAX_AGE_MS } from './policy.js';

export interface CreateAuthDependencies {
  readonly pool: Pool;
  readonly config: Pick<ApiConfig, 'authSecret' | 'appPublicUrl' | 'environment'>;
  readonly sender: EmailService;
  readonly logger: CoreLogger;
  readonly auditRecorder: AuthAuditRecorder;
}

/**
 * Builds an isolated Better Auth instance; all process resources are supplied by the caller.
 *
 * Not annotated with the generic `Auth` type from `better-auth`: that type defaults every
 * `BetterAuthOptions` field to optional, which is not assignable from the concrete, fully-typed
 * options literal below. Letting TypeScript infer the return type keeps it exact.
 */
const buildAuth = (dependencies: CreateAuthDependencies) => {
  const authLogger = {
    level: 'error' as const,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
      dependencies.logger[level]({ operation: 'auth.better_auth', status: level }, message);
    }
  };

  return betterAuth({
    secret: dependencies.config.authSecret,
    baseURL: dependencies.config.appPublicUrl,
    basePath: '/auth',
    trustedOrigins: [dependencies.config.appPublicUrl],
    telemetry: { enabled: false },
    database: {
      dialect: new PostgresDialect({ pool: dependencies.pool }),
      type: 'postgres',
      casing: 'snake',
      schemaName: 'auth',
      transaction: true
    },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: dependencies.config.environment === 'production',
      cookiePrefix: 'ageniza',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['x-ageniza-client-ip'] }
    },
    rateLimit: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false }
    },
    databaseHooks: {
      session: {
        update: {
          // B8: the absolute session lifetime must not depend solely on `session-guard.ts`
          // rejecting an over-age session at request time. This clamps every renewal (including
          // one `getSession`'s own `updateAge` refresh issues) so `expiresAt` can never be pushed
          // past `createdAt + AUTH_SESSION_MAX_AGE_MS`, no matter which code path updates it.
          before: async (data, context) => {
            if (data.expiresAt === undefined) return;
            const createdAt = data.createdAt ?? context?.context.session?.session.createdAt;
            if (createdAt === undefined) return;

            const maxExpiresAt = new Date(new Date(createdAt).getTime() + AUTH_SESSION_MAX_AGE_MS);
            if (new Date(data.expiresAt).getTime() <= maxExpiresAt.getTime()) return;

            return { data: { ...data, expiresAt: maxExpiresAt } };
          }
        }
      }
    },
    verification: { storeIdentifier: 'hashed' },
    emailAndPassword: {
      enabled: true,
      // The public sign-up is `POST /auth/sign-up` (routes.ts), never Better Auth's own endpoint.
      disableSignUp: true,
      // Off on purpose: `POST /auth/login` checks the password itself and refuses an unconfirmed
      // account before it ever calls `signInEmail` (routes.ts), so the login of any unconfirmed account
      // answers like invalid credentials. `signInEmail` must still sign in the one unconfirmed account
      // that gets a session, the one `accept-new-account` just created (2026-10-26 decision on the
      // copyable invitation link, item 2); the session guard then holds the rest of the rule.
      requireEmailVerification: false,
      minPasswordLength: 10,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 60 * 30,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }): Promise<void> => {
        dependencies.sender.sendPasswordReset({ to: user.email, token, inviteToken: currentPasswordResetInviteToken() });
      },
      onPasswordReset: async ({ user }): Promise<void> => {
        // The reset link reached the mailbox, so it confirms an unconfirmed account and voids its
        // pending confirmation links and the Terms acceptance recorded at sign-up: whoever signed up with
        // someone else's address loses it here (finding A1 of the review of PR #720). If this fails the account stays unconfirmed, and its
        // links still ask for the password, which is now the new one.
        try {
          await dependencies.pool.query('select app_private.confirm_email_by_password_reset($1::uuid)', [user.id]);
        } catch (error) {
          dependencies.logger.error({
            operation: 'auth.email_verification_by_reset',
            status: 'failed',
            error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'EMAIL_VERIFICATION_BY_RESET_FAILED' }
          }, 'Failed to confirm the e-mail after a password reset');
          captureUnexpectedError(error, { operation: 'auth.email_verification_by_reset' });
        }
        // The notice about an account e-mail change tells the person to change the password if the
        // request was not theirs, so this is where that request dies (issue #80, security review of
        // PR #325). It never undoes the reset: if it fails, the request is still refused when it is
        // approved or confirmed, because it was made under a credential that no longer exists.
        try {
          await dependencies.pool.query('select app_private.supersede_email_change_requests($1::uuid)', [user.id]);
        } catch (error) {
          dependencies.logger.error({
            operation: 'auth.email_change_supersede',
            status: 'failed',
            error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'EMAIL_CHANGE_SUPERSEDE_FAILED' }
          }, 'Failed to close the open e-mail change requests after a password reset');
          captureUnexpectedError(error, { operation: 'auth.email_change_supersede' });
        }
        // B9: recorded regardless of whether a request id is available (null rather than
        // silently skipped), and a write failure never undoes or blocks the already-completed
        // password reset.
        const requestId = currentAuditRequestId() ?? null;
        await recordAuthAuditEventSafely(
          dependencies.auditRecorder,
          { action: 'auth.password_reset', actorUserId: user.id, requestId },
          dependencies.logger
        );
      }
    },
    logger: authLogger
  });
};

export type AuthInstance = ReturnType<typeof buildAuth>;

const poolsByAuth = new WeakMap<AuthInstance, Pool>();

export const createAuth = (dependencies: CreateAuthDependencies): AuthInstance => {
  const auth = buildAuth(dependencies);
  poolsByAuth.set(auth, dependencies.pool);
  return auth;
};

/**
 * Whether an unconfirmed account may keep a session: only the account created by accepting an
 * invitation, while it keeps the link that invitation gave it (migration 20261027010300). Any
 * failure answers no.
 */
export const unconfirmedAccountMayHoldSession = async (auth: AuthInstance, userId: string): Promise<boolean> => {
  const pool = poolsByAuth.get(auth);
  if (pool === undefined) return false;
  try {
    const result = await pool.query<{ allowed: boolean }>('select app_private.unconfirmed_account_may_hold_session($1::uuid) as allowed', [userId]);
    return result.rows[0]?.allowed === true;
  } catch {
    return false;
  }
};
