import { describe, expect, it } from 'vitest';

import { mobileAppOriginOf, mobileAppRedirectOf } from './mobile-app-origin.js';

const listed = ['ageniza://', 'ageniza-dev://'];

describe('mobileAppOriginOf', () => {
  it('names a listed scheme in either form an app sends it', () => {
    expect(mobileAppOriginOf('ageniza://', listed)).toBe('ageniza://');
    expect(mobileAppOriginOf('ageniza:///', listed)).toBe('ageniza://');
    expect(mobileAppOriginOf('AGENIZA://', listed)).toBe('ageniza://');
  });

  it.each(['evil://', 'ageniza://host', 'ageniza://host/path', 'ageniza', 'https://ageniza', '', 'ageniza:////'])('knows nothing of %s', (value) => {
    expect(mobileAppOriginOf(value, listed)).toBeUndefined();
  });

  it('matches nothing while the list is empty', () => {
    expect(mobileAppOriginOf('ageniza://', [])).toBeUndefined();
  });
});

describe('mobileAppRedirectOf', () => {
  it('accepts a deep link of a listed scheme, keeping its path and query', () => {
    expect(mobileAppRedirectOf('ageniza://auth/google?x=1', listed)?.toString()).toBe('ageniza://auth/google?x=1');
    expect(mobileAppRedirectOf('ageniza-dev:///entrar', listed)).toBeDefined();
  });

  it.each([
    'evil://auth',
    'https://evil.test/x',
    'http://ageniza/x',
    'javascript:alert(1)',
    'ageniza://user:pass@host/x',
    'ageniza://host/x#fragment',
    'ageniza://host/x#',
    'not a url',
    '//evil.test',
    '/entrar'
  ])('refuses %s', (value) => {
    expect(mobileAppRedirectOf(value, listed)).toBeUndefined();
  });

  it('refuses everything while the list is empty', () => {
    expect(mobileAppRedirectOf('ageniza://auth', [])).toBeUndefined();
  });
});
