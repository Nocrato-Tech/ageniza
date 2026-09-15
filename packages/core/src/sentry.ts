import * as Sentry from '@sentry/node';

import { redactSensitiveData, type LogContext } from './logger.js';

let serverSentryEnabled = false;

export interface ServerSentryOptions {
  environment: string;
  dsn?: string;
  release: string;
  isTest?: boolean;
}

/** Sentry is opt-in at runtime: only production with a configured DSN can emit events. */
export const shouldEnableSentry = (options: ServerSentryOptions): boolean =>
  options.environment === 'production' && options.dsn !== undefined && options.dsn.length > 0 && options.isTest !== true;

export const configureServerSentry = (options: ServerSentryOptions): boolean => {
  serverSentryEnabled = shouldEnableSentry(options);
  if (!serverSentryEnabled) return false;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    sendDefaultPii: false,
    beforeSend: (event) => redactSensitiveData(event) as typeof event
  });
  return true;
};

/** Sends unexpected failures with technical correlation only; request payloads are never attached. */
export const captureUnexpectedError = (error: unknown, context: LogContext): void => {
  if (!serverSentryEnabled) return;
  Sentry.withScope((scope) => {
    scope.setTags(redactSensitiveData(context) as Record<string, string>);
    Sentry.captureException(error);
  });
};

/** Flushes the configured production client during shutdown; disabled runtimes return immediately. */
export const flushServerSentry = async (timeoutMs = 2_000): Promise<void> => {
  if (!serverSentryEnabled) return;
  await Sentry.close(timeoutMs);
  serverSentryEnabled = false;
};
