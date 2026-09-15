import { isTestProcess, loadWorkerConfig } from '@ageniza/config/server';
import { createLogger, withLogContext, type CoreLogger } from '@ageniza/core';

export const workerName = 'ageniza-worker';
export const logger: CoreLogger = withLogContext(createLogger(), { module: 'worker', action: 'startup' });

const start = (): void => {
  const config = loadWorkerConfig(process.env);
  logger.info({ environment: config.environment }, 'Worker configuration loaded');
};

if (!isTestProcess(process.env)) {
  start();
}
