import { isTestProcess, loadWorkerConfig } from '@ageniza/config/server';
import { configureServerSentry, createLogger, withLogContext } from '@ageniza/core';

import { smokeJob } from './smoke-job.js';
import { createWorkerRuntime, type WorkerRuntime } from './worker.js';

export * from './jobs.js';
export * from './smoke-job.js';
export * from './worker.js';

export const workerName = 'ageniza-worker';

export const start = async (): Promise<WorkerRuntime> => {
  const config = loadWorkerConfig(process.env);
  configureServerSentry({ environment: config.environment, dsn: config.sentryDsn, release: config.deployVersion, isTest: isTestProcess(process.env) });
  const runtime = createWorkerRuntime({
    config,
    logger: withLogContext(createLogger(), { environment: config.environment, service: config.service, deployVersion: config.deployVersion }),
    ...(config.smokeJob ? { readinessCheck: async () => undefined } : {})
  });

  try {
    await runtime.start();
    if (config.smokeJob) {
      await runtime.jobs.submit(
        { name: 'worker.smoke', payload: { message: 'startup' } },
        smokeJob()
      );
      await runtime.shutdown();
    }
    return runtime;
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
};

if (!isTestProcess(process.env)) {
  void start().catch((error: unknown) => {
    createLogger().error({ error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'STARTUP_FAILED' } }, 'Worker startup failed');
    process.exitCode = 1;
  });
}
