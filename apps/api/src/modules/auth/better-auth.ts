import { betterAuth } from 'better-auth';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { ApiConfig } from '@ageniza/config/server';
import type { CoreLogger } from '@ageniza/core';

import { currentAuditRequestId } from './audit-context.js';
import type { AuthAuditRecorder } from './audit.js';
import type { EmailService } from './email-service.js';

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
    verification: { storeIdentifier: 'hashed' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 60 * 30,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }): Promise<void> => {
        dependencies.sender.sendPasswordReset({ to: user.email, token });
      },
      onPasswordReset: async ({ user }): Promise<void> => {
        const requestId = currentAuditRequestId();
        if (requestId === undefined) return;
        try {
          await dependencies.auditRecorder.record({ action: 'auth.password_reset', actorUserId: user.id, requestId });
        } catch (error) {
          dependencies.logger.error({
            operation: 'auth.password_reset_audit',
            status: 'failed',
            error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'AUDIT_WRITE_FAILED' }
          }, 'Failed to record the auth.password_reset audit event');
        }
      }
    },
    logger: authLogger
  });
};

export type AuthInstance = ReturnType<typeof buildAuth>;

export const createAuth = (dependencies: CreateAuthDependencies): AuthInstance => buildAuth(dependencies);
