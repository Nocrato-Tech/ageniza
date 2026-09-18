import { describe, expect, it } from 'vitest';

import { sanitizeBrowserSentryEvent, shouldEnableBrowserSentry } from './sentry.js';

describe('browser Sentry gate', () => {
  it('only enables production reporting when a public DSN is configured', () => {
    expect(shouldEnableBrowserSentry({ environment: 'production', sentryDsn: 'https://public@example/1' })).toBe(true);
    expect(shouldEnableBrowserSentry({ environment: 'local', sentryDsn: 'https://public@example/1' })).toBe(false);
    expect(shouldEnableBrowserSentry({ environment: 'production' })).toBe(false);
  });

  it('removes browser request bodies and sensitive headers case-insensitively', () => {
    const event = sanitizeBrowserSentryEvent({ request: { data: { password: 'secret' }, cookies: 'session=secret', headers: { Authorization: 'Bearer token', COOKIE: 'session', accept: 'application/json' } } });
    expect(event.request).toEqual({ headers: { accept: 'application/json' } });
  });

  it('removes every copy of the page URL, which on the invitation page is a live token', () => {
    const token = 'invitation-token-in-the-address-bar';
    const event = sanitizeBrowserSentryEvent({
      request: {
        url: `https://app.test/invite/${token}`,
        query_string: `invite=${token}`,
        headers: { Referer: `https://app.test/invite/${token}`, accept: 'text/html' }
      },
      breadcrumbs: [
        { data: { from: `/invite/${token}`, to: '/login' } },
        { data: { url: `https://app.test/invite/${token}` } },
        {}
      ]
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.request).toEqual({ headers: { accept: 'text/html' } });
  });
});
