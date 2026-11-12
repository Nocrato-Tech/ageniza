import { describe, expect, it } from 'vitest';

import { AUTH_SESSION_BROWSERS, AUTH_SESSION_SYSTEMS } from '@ageniza/contracts';

import { describeUserAgent } from './user-agent.js';

// Real `User-Agent` strings, one per browser and system the list names, and the ones that carry another browser's token.
const CASES: readonly (readonly [string, string, string | null, string | null])[] = [
  ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'Windows'],
  ['Chrome on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'macOS'],
  ['Chrome on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'Linux'],
  ['Chrome on ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'ChromeOS'],
  ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android'],
  ['Chrome on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome', 'iOS'],
  ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari', 'macOS'],
  ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
  ['Safari on iPad', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
  ['Firefox on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox', 'Windows'],
  ['Firefox on Linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox', 'Linux'],
  ['Firefox on Android', 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', 'Firefox', 'Android'],
  ['Firefox on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', 'Firefox', 'iOS'],
  ['Edge on Windows, which also says Chrome and Safari', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge', 'Windows'],
  ['Edge on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0', 'Edge', 'Android'],
  ['Edge on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 EdgiOS/130.0.0.0 Mobile/15E148 Safari/605.1.15', 'Edge', 'iOS'],
  ['legacy Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582', 'Edge', 'Windows'],
  ['Opera, which also says Chrome and Safari', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'Opera', 'Windows'],
  ['Samsung Internet, which also says Chrome and Safari', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'Samsung Internet', 'Android'],
  ['an Android WebView, which has no browser name of its own', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android'],
  ['a Windows Phone, which also says Android', 'Mozilla/5.0 (Windows Phone 10.0; Android 4.2.1; Microsoft; Lumia 640) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Mobile Safari/537.36 Edge/12.10166', 'Edge', 'Windows'],
  ['an Opera that still says only Opera', 'Opera/9.80 (Windows NT 6.1; U; en) Presto/2.12.388 Version/12.18', 'Opera', 'Windows'],
  ['a Chromium that says only Chromium', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ubuntu Chromium/130.0.0.0', 'Chrome', 'Linux'],
  ['an iPod', 'Mozilla/5.0 (iPod; U; CPU like Mac OS X; en) AppleWebKit/420.1 (KHTML, like Gecko) Version/3.0 Mobile/3A101a Safari/419.3', 'Safari', 'iOS'],
  ['a Mac that says only Mac OS X', 'Mozilla/5.0 (Mac OS X 10_15_7) Gecko/20100101 Firefox/132.0', 'Firefox', 'macOS'],
  ['an X11 desktop that does not say Linux', 'Mozilla/5.0 (X11; Ubuntu; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox', 'Linux'],
  ['only a Safari token, which names no browser without a Version', 'Mozilla/5.0 (compatible) Safari/537.36', null, null],
  ['only a Version token, which names no browser without Safari', 'Mozilla/5.0 (compatible) Version/17.5', null, null],
  ['curl, which names neither', 'curl/8.5.0', null, null],
  ['a made-up agent', 'ageniza-test/1.0', null, null],
  ['no agent at all', '', null, null]
];

describe('describeUserAgent', () => {
  it.each(CASES)('%s', (_label, userAgent, browser, os) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser, os });
  });

  it('names nothing for an agent that is not there', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null });
    expect(describeUserAgent(undefined)).toEqual({ browser: null, os: null });
  });

  it('answers only from the closed list, whatever the header says: no text of it comes back', () => {
    const hostile = [
      '<script>alert(1)</script>',
      'Firefox/1 "; drop table auth.session; --',
      `Chrome/130 ${'A'.repeat(100_000)}`,
      'SECRET-UA-MARKER-9f3a Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36'
    ];
    for (const userAgent of hostile) {
      const described = describeUserAgent(userAgent);
      expect(described.browser === null || (AUTH_SESSION_BROWSERS as readonly string[]).includes(described.browser)).toBe(true);
      expect(described.os === null || (AUTH_SESSION_SYSTEMS as readonly string[]).includes(described.os)).toBe(true);
      expect(JSON.stringify(described)).not.toContain('SECRET-UA-MARKER');
      expect(JSON.stringify(described)).not.toContain('script');
    }
  });

  it('reads exactly the first 512 characters of a long header: a token that ends at 512 counts, one that crosses it does not', () => {
    const token = 'Firefox/';
    expect(describeUserAgent(`${'x'.repeat(512 - token.length)}${token}`)).toEqual({ browser: 'Firefox', os: null });
    expect(describeUserAgent(`${'x'.repeat(512 - token.length + 1)}${token}`)).toEqual({ browser: null, os: null });
    expect(describeUserAgent(`${'x'.repeat(512)} Firefox/132.0 Windows`)).toEqual({ browser: null, os: null });
  });
});
