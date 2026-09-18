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
    beforeSend: (event) => redactSensitiveData(stripRequestUrl(event)) as typeof event,
    // Transactions never reach beforeSend; they have their own hook. No sample rate is configured
    // today, so none are emitted, but enabling tracing must not silently reopen this.
    beforeSendTransaction: (event) => redactSensitiveData(stripRequestUrl(event)) as typeof event
  });
  return true;
};

/**
 * The SDK attaches the request URL on its own, and `sendDefaultPii: false` does not turn that off.
 * A path segment can be a secret — `/invitations/<token>` — and redaction matches key names, not a
 * token embedded in a path, so these are dropped outright (issue #37). The `route` tag carries the
 * route pattern, which is what correlation actually needs.
 */
export const stripRequestUrl = <T extends { request?: { url?: string; query_string?: unknown; headers?: Record<string, unknown> } }>(event: T): T => {
  if (event.request === undefined) return event;
  delete event.request.url;
  delete event.request.query_string;
  for (const header of Object.keys(event.request.headers ?? {})) {
    if (header.toLowerCase() === 'referer') delete event.request.headers![header];
  }
  return event;
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
