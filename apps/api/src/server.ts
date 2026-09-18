import { Pool } from 'pg';

import { isTestProcess, loadApiConfig } from '@ageniza/config/server';
import { captureUnexpectedError, configureServerSentry, createLogger, createReadiness, createShutdownManager, flushServerSentry, registerShutdownSignals, type HealthCheck } from '@ageniza/core';
import { createEmailSender } from '@ageniza/email';
import { createDatabaseClient } from '@ageniza/database';

import { buildApp } from './app.js';
import { createAuthAuditRecorder } from './modules/auth/audit.js';
import { createAuthLimiter } from './modules/auth/auth-limiter.js';
import { createAuth } from './modules/auth/better-auth.js';
import { createEmailService } from './modules/auth/email-service.js';
import { createRequireAgencyAccess, requirePermission } from './modules/tenancy/guards.js';
import { createInvitationTokenLookup, type InvitationModuleDependencies } from './modules/invitations/routes.js';

/** Dedicated to Better Auth (and, since it shares the same `ageniza_app` role and connection
 * settings, to append-only audit writes); small on purpose on a shared VPS. */
const AUTH_POOL_MAX_CONNECTIONS = 4;

/** Starts the process-owned HTTP listener. App construction remains importable and side-effect free. */
export const startApi = async (): Promise<void> => {
  const config = loadApiConfig(process.env);
  configureServerSentry({ environment: config.environment, dsn: config.sentryDsn, release: config.deployVersion, isTest: isTestProcess(process.env) });
  const logger = createLogger();

  if (config.smtpUrl === undefined || config.emailFrom === undefined) {
    throw new Error('SMTP_URL and EMAIL_FROM are required to start the API: the auth module sends password reset email.');
  }

  const authPool = new Pool({ connectionString: config.databaseUrl, max: AUTH_POOL_MAX_CONNECTIONS });
  const database = createDatabaseClient({ connectionString: config.databaseUrl });
  const sender = createEmailSender({ smtpUrl: config.smtpUrl, from: config.emailFrom, logger });
  const emailService = createEmailService({ sender, config: { appPublicUrl: config.appPublicUrl }, logger });
  const auditRecorder = createAuthAuditRecorder(authPool);
  const auth = createAuth({ pool: authPool, config, sender: emailService, logger, auditRecorder });
  const limiter = createAuthLimiter();
  const invitationTokenLookup = createInvitationTokenLookup(database);
  const invitationDependencies: InvitationModuleDependencies = {
    database,
    auth,
    emailService,
    auditRecorder,
    config: {
      appPublicUrl: config.appPublicUrl,
      authTermsVersion: config.authTermsVersion,
      authPrivacyVersion: config.authPrivacyVersion
    },
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    invitationTokenLookup
  };

  const readiness = createReadiness(false);
  const dependencyChecks: readonly HealthCheck[] = [
    { name: 'auth-database', check: async () => { await authPool.query('select 1'); } }
  ];
  const app = await buildApp({
    config,
    logger,
    readiness,
    dependencyChecks,
    auth: { auth, limiter, auditRecorder, invitationTokenLookup },
    invitations: invitationDependencies
  });

  const shutdown = createShutdownManager();
  shutdown.add('sentry', async () => { await flushServerSentry(); });
  shutdown.add('auth-pool', async () => { await authPool.end(); });
  shutdown.add('database', async () => { await database.close(); });
  // Waits for in-flight password reset email deliveries (max 10s), never blocking the response
  // that already went out.
  shutdown.add('auth-email', async () => { await emailService.drain(); });
  shutdown.add('fastify', async () => { await app.close(); });
  shutdown.add('readiness', () => { readiness.setReady(false); });
  registerShutdownSignals(shutdown, {
    onFailure: (result) => {
      app.log.error({ failedHandlers: result.failures.map((failure) => failure.name) }, 'Graceful shutdown completed with failures');
      process.exitCode = 1;
    }
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    readiness.setReady(true);
  } catch (error) {
    const telemetry = { environment: config.environment, service: config.service, deployVersion: config.deployVersion, operation: 'api.startup', status: 'failed' };
    app.log.fatal({ ...telemetry, error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'STARTUP_FAILED' } }, 'API startup failed');
    captureUnexpectedError(error, telemetry);
    await shutdown.run();
    throw error;
  }
};
