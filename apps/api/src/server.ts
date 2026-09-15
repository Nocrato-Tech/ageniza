import { loadApiConfig } from '@ageniza/config/server';
import { createReadiness, createShutdownManager, registerShutdownSignals } from '@ageniza/core';

import { buildApp } from './app.js';

/** Starts the process-owned HTTP listener. App construction remains importable and side-effect free. */
export const startApi = async (): Promise<void> => {
  const config = loadApiConfig(process.env);
  const readiness = createReadiness(false);
  const app = await buildApp({ config, readiness });
  const shutdown = createShutdownManager();
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
    app.log.fatal({ err: error }, 'API startup failed');
    await shutdown.run();
    throw error;
  }
};
