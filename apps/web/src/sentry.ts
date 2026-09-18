import * as Sentry from '@sentry/react';

import type { BrowserConfig } from '@ageniza/config/browser';

let enabled = false;

interface SanitizableBrowserEvent {
  request?: { data?: unknown; cookies?: unknown; url?: string; query_string?: unknown; headers?: Record<string, unknown> };
  breadcrumbs?: Array<{ data?: Record<string, unknown> }>;
}

/**
 * Removes browser request payload, URLs and sensitive headers before any event leaves the page.
 * The invitation link is `/invite/<token>`, so the page URL itself is a live credential (issue
 * #37): the SDK copies it into `request.url`, the `Referer` header and every navigation
 * breadcrumb, and `sendDefaultPii: false` does not suppress any of those.
 */
export const sanitizeBrowserSentryEvent = <T extends SanitizableBrowserEvent>(event: T): T => {
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.data === undefined) continue;
    delete breadcrumb.data.from;
    delete breadcrumb.data.to;
    delete breadcrumb.data.url;
  }
  if (event.request === undefined) return event;
  delete event.request.data;
  delete event.request.cookies;
  delete event.request.url;
  delete event.request.query_string;
  if (event.request.headers !== undefined) {
    for (const header of Object.keys(event.request.headers)) {
      const name = header.toLowerCase();
      if (name === 'authorization' || name === 'cookie' || name === 'referer') delete event.request.headers[header];
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
