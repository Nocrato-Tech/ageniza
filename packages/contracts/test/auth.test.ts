import { describe, expect, it } from 'vitest';

import {
  AUTH_SESSION_BROWSERS,
  AUTH_SESSION_LIST_MAX,
  AUTH_SESSION_SYSTEMS,
  AuthActiveSessionSchema,
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthLogoutAllRequestSchema,
  AuthLogoutResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthPasswordResetResponseSchema,
  AuthRevokeOtherSessionsRequestSchema,
  AuthRevokeOtherSessionsResponseSchema,
  AuthRevokeSessionRequestSchema,
  AuthSessionListResponseSchema,
  AuthSessionPathParamsSchema,
  AuthSessionResponseSchema
} from '../src/index.js';

describe('authentication contracts', () => {
  it('normalizes emails and enforces the shared password bounds', () => {
    expect(AuthLoginRequestSchema.parse({ email: ' Person@Example.TEST ', password: '1234567890' })).toEqual({
      email: 'person@example.test',
      password: '1234567890'
    });
    // Signing in presents a password, it does not create one: a short wrong password is a 401 for the server to give.
    expect(AuthLoginRequestSchema.parse({ email: 'person@example.test', password: 'short' }).password).toBe('short');
    expect(() => AuthLoginRequestSchema.parse({ email: 'person@example.test', password: '' })).toThrow();
    expect(() => AuthLoginRequestSchema.parse({ email: 'person@example.test', password: 'x'.repeat(129) })).toThrow();
  });

  it('keeps login and session responses limited to their public fields', () => {
    const user = { id: 'user-1', name: 'Person', email: 'person@example.test' };
    expect(AuthLoginResponseSchema.parse({ user })).toEqual({ user });
    expect(() => AuthLoginResponseSchema.parse({ user: { ...user, password: 'secret' } })).toThrow();
    expect(AuthSessionResponseSchema.parse({
      user,
      session: { expiresAt: '2030-01-01T00:00:00.000Z' }
    })).toEqual({ user, session: { expiresAt: '2030-01-01T00:00:00.000Z' } });
  });

  it('models forgot/reset request and response shapes without exposing secrets', () => {
    expect(AuthPasswordForgotRequestSchema.parse({ email: ' Person@Example.TEST ' })).toEqual({ email: 'person@example.test' });
    expect(AuthPasswordForgotResponseSchema.parse({})).toEqual({});
    expect(AuthPasswordResetRequestSchema.parse({ token: 'reset-token', newPassword: 'new-password' })).toEqual({ token: 'reset-token', newPassword: 'new-password' });
    expect(() => AuthPasswordResetRequestSchema.parse({ token: 'reset-token', newPassword: 'short' })).toThrow();
  });

  it('accepts an opaque invitation continuation token on login/forgot, and refuses it on reset', () => {
    const inviteToken = 'invite-token';
    expect(AuthLoginRequestSchema.parse({ email: 'person@example.test', password: '1234567890', inviteToken })).toEqual({
      email: 'person@example.test', password: '1234567890', inviteToken
    });
    expect(AuthPasswordForgotRequestSchema.parse({ email: 'person@example.test', inviteToken })).toEqual({
      email: 'person@example.test', inviteToken
    });
    expect(() => AuthPasswordForgotRequestSchema.parse({ email: 'person@example.test', inviteToken: '' })).toThrow();
    // The reset ends no session in favour of a new one: the invitation continues through the login.
    expect(() => AuthPasswordResetRequestSchema.parse({ token: 'reset-token', newPassword: 'new-password', inviteToken })).toThrow();
  });

  it('models the password/reset response as bodyless, like logout (2026-10-16)', () => {
    expect(AuthPasswordResetResponseSchema.parse(undefined)).toBeUndefined();
    expect(() => AuthPasswordResetResponseSchema.parse({ signedIn: true })).toThrow();
    expect(() => AuthPasswordResetResponseSchema.parse({})).toThrow();
  });

  it('models logout requests and 204 responses as bodyless', () => {
    expect(AuthLogoutAllRequestSchema.parse(undefined)).toBeUndefined();
    expect(AuthLogoutResponseSchema.parse(undefined)).toBeUndefined();
    expect(() => AuthLogoutAllRequestSchema.parse({})).toThrow();
  });
});

describe('active sessions contracts (issue #893)', () => {
  const session = {
    id: '3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f',
    current: true,
    browser: 'Chrome',
    os: 'Windows',
    city: 'São Paulo',
    lastUsedAt: '2026-11-12T10:00:00.000Z',
    createdAt: '2026-11-11T10:00:00.000Z'
  };

  it('shows a session by what the person recognises, and nothing that identifies the connection', () => {
    expect(AuthActiveSessionSchema.parse(session)).toEqual(session);
    expect(AuthActiveSessionSchema.parse({ ...session, browser: null, os: null, city: null })).toMatchObject({ browser: null, os: null, city: null });
    for (const leaked of ['ipAddress', 'token', 'userAgent', 'userId', 'expiresAt', 'updatedAt']) {
      expect(() => AuthActiveSessionSchema.parse({ ...session, [leaked]: 'x' }), leaked).toThrow();
    }
    expect(Object.keys(AuthActiveSessionSchema.shape).sort()).toEqual(['browser', 'city', 'createdAt', 'current', 'id', 'lastUsedAt', 'os']);
  });

  it('names the browser and the system from closed lists, never from the text the header carried', () => {
    for (const browser of AUTH_SESSION_BROWSERS) expect(AuthActiveSessionSchema.parse({ ...session, browser }).browser).toBe(browser);
    for (const os of AUTH_SESSION_SYSTEMS) expect(AuthActiveSessionSchema.parse({ ...session, os }).os).toBe(os);
    expect(() => AuthActiveSessionSchema.parse({ ...session, browser: 'Mozilla/5.0 (Windows NT 10.0)' })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, os: 'Plan 9' })).toThrow();
  });

  it('keeps the city between 1 and 80 characters, the bounds of the column', () => {
    expect(AuthActiveSessionSchema.parse({ ...session, city: 'a' }).city).toBe('a');
    expect(AuthActiveSessionSchema.parse({ ...session, city: 'a'.repeat(80) }).city).toHaveLength(80);
    expect(() => AuthActiveSessionSchema.parse({ ...session, city: '' })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, city: 'a'.repeat(81) })).toThrow();
  });

  it('wants an id that is a UUID, the two instants as ISO dates, and the current flag as a boolean', () => {
    expect(() => AuthActiveSessionSchema.parse({ ...session, id: 'not-a-uuid' })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, lastUsedAt: 'yesterday' })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, createdAt: 1_700_000_000 })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, current: 'true' })).toThrow();
    expect(() => AuthActiveSessionSchema.parse({ ...session, current: undefined })).toThrow();
  });

  it('limits the list to the most the route returns, and wants the key', () => {
    expect(AUTH_SESSION_LIST_MAX).toBe(100);
    expect(AuthSessionListResponseSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
    expect(AuthSessionListResponseSchema.parse({ sessions: Array.from({ length: AUTH_SESSION_LIST_MAX }, () => session) }).sessions).toHaveLength(100);
    expect(() => AuthSessionListResponseSchema.parse({ sessions: Array.from({ length: AUTH_SESSION_LIST_MAX + 1 }, () => session) })).toThrow();
    expect(() => AuthSessionListResponseSchema.parse({})).toThrow();
    expect(() => AuthSessionListResponseSchema.parse({ sessions: [], total: 0 })).toThrow();
  });

  it('takes the session id as plain text, so a malformed one is a 404 of the route and not a 400 that tells it apart', () => {
    expect(AuthSessionPathParamsSchema.parse({ sessionId: 'not-a-uuid' })).toEqual({ sessionId: 'not-a-uuid' });
    expect(AuthSessionPathParamsSchema.parse({ sessionId: 'a'.repeat(100) }).sessionId).toHaveLength(100);
    expect(() => AuthSessionPathParamsSchema.parse({ sessionId: '' })).toThrow();
    expect(() => AuthSessionPathParamsSchema.parse({ sessionId: 'a'.repeat(101) })).toThrow();
    expect(() => AuthSessionPathParamsSchema.parse({ sessionId: 'a', other: 'b' })).toThrow();
  });

  it('takes no body to end one session or the others, and answers how many the others were', () => {
    expect(AuthRevokeSessionRequestSchema.parse(undefined)).toBeUndefined();
    expect(AuthRevokeOtherSessionsRequestSchema.parse(undefined)).toBeUndefined();
    expect(() => AuthRevokeSessionRequestSchema.parse({})).toThrow();
    expect(() => AuthRevokeOtherSessionsRequestSchema.parse({})).toThrow();
    expect(AuthRevokeOtherSessionsResponseSchema.parse({ revoked: 0 })).toEqual({ revoked: 0 });
    expect(AuthRevokeOtherSessionsResponseSchema.parse({ revoked: 7 })).toEqual({ revoked: 7 });
    expect(() => AuthRevokeOtherSessionsResponseSchema.parse({ revoked: -1 })).toThrow();
    expect(() => AuthRevokeOtherSessionsResponseSchema.parse({ revoked: 1.5 })).toThrow();
    expect(() => AuthRevokeOtherSessionsResponseSchema.parse({ revoked: 1, sessions: [] })).toThrow();
    expect(() => AuthRevokeOtherSessionsResponseSchema.parse({})).toThrow();
  });
});
