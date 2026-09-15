import { createLogger, withLogContext, type CoreLogger } from '@ageniza/core';

export const workerName = 'ageniza-worker';
export const logger: CoreLogger = withLogContext(createLogger(), { module: 'worker', action: 'startup' });
