import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-linking', () => ({ createURL: () => 'ageniza://' }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { addEventListener: vi.fn() } }));
import { getCookie, getSetCookie, hasBetterAuthCookies } from '@better-auth/expo/client';
import { createApiClient } from './client';

describe('installed Better Auth cookie codec', () => {
  it('persists __Secure-ageniza and restores the same cookie in a reopened client', async () => {
    let saved: string | null = null;
    const storage = { get: async () => saved, set: async (value: string) => { saved = value; }, clear: async () => { saved = null; } };
    const codec = { getCookie, getSetCookie, hasBetterAuthCookies };
    const first = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'Set-Cookie': '__Secure-ageniza.session_token=test-only; Path=/; Secure; HttpOnly; Max-Age=3600' } }));
    await createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, first).request('/auth/login', { method: 'POST', body: {} });
    expect(saved).toContain('__Secure-ageniza.session_token');
    const reopened = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, reopened).request('/auth/session');
    expect(new Headers(reopened.mock.calls[0][1]?.headers).get('Cookie')).toBe('__Secure-ageniza.session_token=test-only');
  });
  it('does not accept an unrelated prefix or restore an expired cookie', () => {
    expect(hasBetterAuthCookies('__Secure-another.session_token=test; Secure', 'ageniza')).toBe(false);
    expect(getCookie(getSetCookie('__Secure-ageniza.session_token=old; Max-Age=0; Path=/; Secure'))).toBe('');
  });
});
