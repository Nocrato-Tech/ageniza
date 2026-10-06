import { describe, expect, it } from 'vitest';

import { apiPath } from './api-path.js';

// Issue #193. The HttpClient barrier cannot see a raw `/` or `?` that comes from a value, because
// to it those already look like path structure. `apiPath`'s `encodeURIComponent` is therefore the
// only thing keeping a route parameter inside its own segment, and it is the helper the next screens
// (#102-#108, #134-#140) are meant to use.
describe('apiPath', () => {
  it('encodes a value with a slash as a single segment instead of a new one', () => {
    expect(apiPath('/invitations/:token', { token: 'abc/accept' })).toBe('/invitations/abc%2Faccept');
  });

  it('encodes query, fragment, percent and space inside a value', () => {
    expect(apiPath('/invitations/:token', { token: 'abc?x=1' })).toBe('/invitations/abc%3Fx%3D1');
    expect(apiPath('/invitations/:token', { token: 'abc#frag' })).toBe('/invitations/abc%23frag');
    expect(apiPath('/invitations/:token', { token: 'abc%2F' })).toBe('/invitations/abc%252F');
    expect(apiPath('/agencies/:agenciaId/me', { agenciaId: 'a b' })).toBe('/agencies/a%20b/me');
  });

  it('encodes `..` inside a value so it never becomes a relative segment', () => {
    expect(apiPath('/invitations/:token', { token: 'a/../b' })).toBe('/invitations/a%2F..%2Fb');
  });

  it('refuses an empty, `.` or `..` value outright', () => {
    expect(() => apiPath('/agencies/:agenciaId/me', { agenciaId: '' })).toThrow();
    expect(() => apiPath('/agencies/:agenciaId/me', { agenciaId: '.' })).toThrow();
    expect(() => apiPath('/agencies/:agenciaId/me', { agenciaId: '..' })).toThrow();
    expect(() => apiPath('/agencies/:agenciaId/me', {})).toThrow();
  });

  it('replaces every placeholder and leaves the literal template intact', () => {
    expect(apiPath('/agencies/:agenciaId/clients/:clientId', { agenciaId: 'a/b', clientId: 'c?d' }))
      .toBe('/agencies/a%2Fb/clients/c%3Fd');
  });
});
