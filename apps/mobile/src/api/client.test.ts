import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client';
import type { SessionStorage } from './client';

const codec = {
  getCookie: (stored: string | null) => stored === 'saved-session' ? 'ageniza.session_token=secret' : '',
  getSetCookie: () => 'saved-session',
  hasBetterAuthCookies: () => true
};

function memory() {
  let value: string | null = null;
  return { get: async () => value, set: async (next: string) => { value = next; }, clear: async () => { value = null; } } satisfies SessionStorage;
}
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });

describe('native API transport', () => {
  it('stores the session cookie and returns it without a browser Origin', async () => {
    const storage = memory();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 200, { 'set-cookie': 'ageniza.session_token=secret; Path=/; HttpOnly; Max-Age=3600' })).mockResolvedValueOnce(json({ ok: true }));
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher);
    await api.request('/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'password' } });
    await api.request('/auth/session');
    const headers = new Headers(fetcher.mock.calls[1][1]?.headers);
    expect(fetcher.mock.calls[0][0]).toBe('https://dev.ageniza.com.br/api/auth/login');
    expect(headers.get('cookie')).toBe('ageniza.session_token=secret');
    expect(headers.get('expo-origin')).toBe('ageniza://');
    expect(headers.has('origin')).toBe(false);
    expect(fetcher.mock.calls[1][1]?.credentials).toBe('omit');
  });
  it('clears a revoked session and informs the UI on any 401', async () => {
    const storage = memory();
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, vi.fn().mockResolvedValue(json({ error: { code: 'SESSION_EXPIRED', message: 'Sessão encerrada.' } }, 401)));
    await storage.set('stored');
    const expired = vi.fn(); api.onExpired(expired);
    await expect(api.request('/clients/one')).rejects.toMatchObject({ status: 401 });
    expect(await storage.get()).toBeNull(); expect(expired).toHaveBeenCalledOnce();
  });
  it('does not resurrect cookies from a response arriving after logout', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const storage = memory();
    const fetcher = vi.fn().mockReturnValue(response);
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher);
    const request = api.request('/auth/session');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await api.clearSession();
    release(json({}, 200, { 'set-cookie': 'ageniza.session_token=old; Path=/; Max-Age=3600' }));
    await expect(request).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(await storage.get()).toBeNull();
  });
  it('keeps browser credentials in HttpOnly cookies, without native headers or storage', async () => {
    const storage = memory(); const write = vi.spyOn(storage, 'set');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 200, { 'set-cookie': 'ageniza.session_token=secret' }));
    await createApiClient('https://dev.ageniza.com.br/api', storage, false, codec, fetcher).request('/auth/session');
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.has('cookie')).toBe(false); expect(headers.has('expo-origin')).toBe(false);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe('include'); expect(write).not.toHaveBeenCalled();
  });
  it('explains a server that has not enabled native origins', async () => {
    const api = createApiClient('https://dev.ageniza.com.br/api', memory(), true, codec, vi.fn().mockResolvedValue(json({ error: { code: 'CSRF_REJECTED' } }, 403)));
    await expect(api.request('/auth/login')).rejects.toMatchObject({ code: 'CSRF_REJECTED', message: expect.stringContaining('ageniza://') });
  });
  it('ignores unrelated response cookies', async () => {
    const storage = memory(); const write = vi.spyOn(storage, 'set');
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, { ...codec, hasBetterAuthCookies: () => false }, vi.fn().mockResolvedValue(json({}, 200, { 'set-cookie': 'unrelated=value' })));
    await api.request('/health'); expect(write).not.toHaveBeenCalled();
  });
  it('refuses plaintext remote API endpoints and absolute request paths', async () => {
    expect(() => createApiClient('http://example.com', memory(), true, codec)).toThrow('HTTPS');
    const fetcher = vi.fn(); const api = createApiClient('https://dev.ageniza.com.br/api', memory(), true, codec, fetcher);
    await expect(api.request('//evil.test')).rejects.toThrow('inválido'); expect(fetcher).not.toHaveBeenCalled();
  });
});
