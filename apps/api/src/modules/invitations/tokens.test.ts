import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  INVITATION_TOKEN_BYTES,
  INVITATION_TOKEN_TTL_MS,
  createInvitationToken,
  generateInvitationToken,
  hashInvitationToken,
  invitationLink
} from './tokens.js';

describe('invitation token primitives', () => {
  it('generates a 32-byte base64url token', () => {
    const token = generateInvitationToken();

    expect(Buffer.from(token, 'base64url')).toHaveLength(INVITATION_TOKEN_BYTES);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('=');
  });

  it('hashes the raw token as lowercase SHA-256 hexadecimal', () => {
    const expected = createHash('sha256').update('known-token').digest('hex');

    expect(hashInvitationToken('known-token')).toBe(expected);
    expect(hashInvitationToken('known-token')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds a seven-day invitation link and expiry from one timestamp', () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const result = createInvitationToken({ appPublicUrl: 'https://app.example.test', now });

    expect(result.token).toHaveLength(43);
    expect(result.tokenHash).toBe(hashInvitationToken(result.token));
    expect(result.expiresAt.toISOString()).toBe('2026-09-24T12:00:00.000Z');
    expect(result.expiresAt.getTime() - now.getTime()).toBe(INVITATION_TOKEN_TTL_MS);
    expect(result.actionUrl).toBe(`https://app.example.test/convite/${result.token}`);
    // Rota em português é decisão de specs/auth.md: o link viaja por e-mail e por mensagem.
    expect(result.actionUrl).not.toContain('/invite/');
    expect(invitationLink('https://app.example.test', result.token)).toBe(result.actionUrl);
  });

  it('does not leak a trailing slash into the invitation link', () => {
    const token = 'abc';

    expect(invitationLink('https://app.example.test/', token)).toBe('https://app.example.test/convite/abc');
  });
});
