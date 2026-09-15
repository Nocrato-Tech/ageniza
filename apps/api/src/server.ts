import { isTestProcess, loadApiConfig } from '@ageniza/config/server';
import { captureUnexpectedError, configureServerSentry, createReadiness, createShutdownManager, flushServerSentry, registerShutdownSignals } from '@ageniza/core';

import { buildApp } from './app.js';

/** Starts the process-owned HTTP listener. App construction remains importable and side-effect free. */
export const startApi = async (): Promise<void> => {
  const config = loadApiConfig(process.env);
  configureServerSentry({ environment: config.environment, dsn: config.sentryDsn, release: config.deployVersion, isTest: isTestProcess(process.env) });
  const readiness = createReadiness(false);
  const app = await buildApp({ config, readiness });
  const shutdown = createShutdownManager();
  shutdown.add('sentry', async () => { await flushServerSentry(); });
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
