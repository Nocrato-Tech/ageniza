import { describe, expect, it } from 'vitest';

import {
  AuthLoginRequestSchema,
  AuthLoginResponseSchema,
  AuthLogoutAllRequestSchema,
  AuthLogoutResponseSchema,
  AuthPasswordForgotRequestSchema,
  AuthPasswordForgotResponseSchema,
  AuthPasswordResetRequestSchema,
  AuthSessionResponseSchema
} from '../src/index.js';

describe('authentication contracts', () => {
  it('normalizes emails and enforces the shared password bounds', () => {
    expect(AuthLoginRequestSchema.parse({ email: ' Person@Example.TEST ', password: '1234567890' })).toEqual({
      email: 'person@example.test',
      password: '1234567890'
    });
    expect(() => AuthLoginRequestSchema.parse({ email: 'person@example.test', password: 'short' })).toThrow();
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

  it('models logout requests and 204 responses as bodyless', () => {
    expect(AuthLogoutAllRequestSchema.parse(undefined)).toBeUndefined();
    expect(AuthLogoutResponseSchema.parse(undefined)).toBeUndefined();
    expect(() => AuthLogoutAllRequestSchema.parse({})).toThrow();
  });
});
