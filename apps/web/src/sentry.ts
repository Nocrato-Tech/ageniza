import * as Sentry from '@sentry/react';

import type { BrowserConfig } from '@ageniza/config/browser';

let enabled = false;

/** Removes browser request payload and sensitive headers before any event leaves the page. */
export const sanitizeBrowserSentryEvent = <T extends { request?: { data?: unknown; cookies?: unknown; headers?: Record<string, unknown> } }>(event: T): T => {
  if (event.request === undefined) return event;
  delete event.request.data;
  delete event.request.cookies;
  if (event.request.headers !== undefined) {
    for (const header of Object.keys(event.request.headers)) {
      if (header.toLowerCase() === 'authorization' || header.toLowerCase() === 'cookie') delete event.request.headers[header];
    }
  }
  return event;
};

/** Browser error reporting is public-DSN only and never active outside production. */
export const shouldEnableBrowserSentry = (config: Pick<BrowserConfig, 'environment' | 'sentryDsn'>): boolean =>
  config.environment === 'production' && config.sentryDsn !== undefined && config.sentryDsn.length > 0;

export const configureBrowserSentry = (config: BrowserConfig): boolean => {
  enabled = shouldEnableBrowserSentry(config);
  if (!enabled) return false;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment,
    release: config.deployVersion,
    sendDefaultPii: false,
    beforeSend: sanitizeBrowserSentryEvent
  });
  return true;
};

/** Error boundaries use this explicit path because caught React render errors are not global errors. */
export const captureBrowserException = (error: unknown, context?: Record<string, string>): void => {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context !== undefined) scope.setTags(context);
    Sentry.captureException(error);
  });
};
