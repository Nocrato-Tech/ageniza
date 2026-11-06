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
  it('does not restore a cookie when logout races a pending write and secure deletion fails', async () => {
    let value: string | null = 'saved-session'; let release!: () => void;
    const storage = { get: async () => value, set: vi.fn((next: string) => new Promise<void>((resolve) => { release = () => { value = next; resolve(); }; })), clear: vi.fn().mockRejectedValue(new Error('delete failed')) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 200, { 'set-cookie': 'ageniza.session_token=new' })).mockResolvedValueOnce(json({ ok: true }));
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher);
    const login = api.request('/auth/login', { method: 'POST', body: {} });
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledOnce());
    const clearing = api.clearSession().catch(() => {}); release();
    await expect(login).rejects.toMatchObject({ code: 'STALE_SESSION' }); await clearing;
    await api.request('/health'); expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('Cookie')).toBe(false);
  });
  it('recovers from a failed secure write without poisoning later requests', async () => {
    const storage = memory();
    vi.spyOn(storage, 'set').mockRejectedValueOnce(new Error('secure storage unavailable'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 200, { 'set-cookie': 'ageniza.session_token=new' })).mockResolvedValueOnce(json({ ok: true }));
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher);
    await expect(api.request('/auth/login', { method: 'POST', body: {} })).rejects.toThrow('secure storage');
    await expect(api.request('/health')).resolves.toEqual({ ok: true });
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('Cookie')).toBe(false);
  });
  it('expires access even when deleting the revoked secure session fails', async () => {
    const storage = memory(); await storage.set('saved-session');
    vi.spyOn(storage, 'clear').mockRejectedValueOnce(new Error('delete failed'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ ok: true }));
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher); const expired = vi.fn(); api.onExpired(expired);
    await expect(api.request('/auth/session')).rejects.toThrow('delete failed'); expect(expired).toHaveBeenCalledOnce();
    await api.request('/health'); expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('Cookie')).toBe(false);
  });
  it('does not erase an existing session after an invalid login attempt', async () => {
    const storage = memory(); await storage.set('saved-session'); const expired = vi.fn();
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, vi.fn().mockResolvedValue(json({ error: { code: 'INVALID_CREDENTIALS' } }, 401))); api.onExpired(expired);
    await expect(api.request('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
    expect(await storage.get()).toBe('saved-session'); expect(expired).not.toHaveBeenCalled();
  });
  it('rejects a foreign final URL before reading or persisting its cookies', async () => {
    const response = json({}, 200, { 'set-cookie': 'ageniza.session_token=foreign' });
    Object.defineProperty(response, 'url', { value: 'https://foreign.example/api/auth/login' });
    const storage = memory(); const write = vi.spyOn(storage, 'set');
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, vi.fn().mockResolvedValue(response));
    await expect(api.request('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'UNSAFE_REDIRECT' }); expect(write).not.toHaveBeenCalled();
  });
  it('sends a zero-length POST body for logout and routes access-policy changes to entry resolution', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json({ error: { code: 'TERMS_NOT_ACCEPTED' } }, 403));
    const api = createApiClient('https://dev.ageniza.com.br/api', memory(), true, codec, fetcher); const required = vi.fn(); api.onAccessRequired(required);
    await api.request('/auth/logout', { method: 'POST' }); expect(fetcher.mock.calls[0][1]?.body).toBe('');
    await expect(api.request('/clients/one')).rejects.toMatchObject({ status: 403 }); expect(required).toHaveBeenCalledOnce();
  });
  it('preserves the secure session cookie name when persisting and reopening the transport', async () => {
    const storage = memory();
    const secureCookie = '__Secure-ageniza.session_token=test-only';
    const secureCodec = { getCookie: (value: string | null) => value ?? '', getSetCookie: (header: string) => header.split(';')[0], hasBetterAuthCookies: (header: string, prefix: string) => header.startsWith(`__Secure-${prefix}.`) };
    const first = vi.fn<typeof fetch>().mockResolvedValue(json({}, 200, { 'set-cookie': `${secureCookie}; Path=/; HttpOnly; Secure; Max-Age=3600` }));
    await createApiClient('https://dev.ageniza.com.br/api', storage, true, secureCodec, first).request('/auth/login', { method: 'POST', body: {} });
    expect(await storage.get()).toBe(secureCookie);
    const reopened = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    await createApiClient('https://dev.ageniza.com.br/api', storage, true, secureCodec, reopened).request('/auth/session');
    expect(new Headers(reopened.mock.calls[0][1]?.headers).get('Cookie')).toBe(secureCookie);
  });
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
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    expect(fetcher.mock.calls[1][1]?.redirect).toBe('error');
  });
  it('clears a revoked session and informs the UI on any 401', async () => {
    const storage = memory();
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, vi.fn().mockResolvedValue(json({ error: { code: 'SESSION_EXPIRED', message: 'Sessão encerrada.' } }, 401)));
    await storage.set('saved-session');
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


describe('session response ordering', () => {
  it('does not invalidate an anonymous invitation preview when cold restore returns 401', async () => {
    let release!: (response: Response) => void;
    const preview = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('invitations') ? preview : json({}, 401));
    const api = createApiClient('https://dev.ageniza.com.br/api', memory(), true, codec, fetcher);
    const pending = api.request('/invitations/token');
    await expect(api.request('/auth/session')).rejects.toMatchObject({ status: 401 });
    release(json({ email: 'invited@example.test' }));
    await expect(pending).resolves.toEqual({ email: 'invited@example.test' });
  });
  it('does not let a delayed revoked-session response erase a newer login', async () => {
    let release!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => { release = resolve; });
    const storage = memory(); await storage.set('saved-session'); const expired = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith('/auth/login') ? json({}, 200, { 'set-cookie': 'ageniza.session_token=new' }) : stale);
    const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, fetcher); api.onExpired(expired);
    const pending = api.request('/auth/session/check');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await api.request('/auth/login', { method: 'POST', body: {} });
    release(json({}, 401));
    await expect(pending).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(await storage.get()).toBe('saved-session'); expect(expired).not.toHaveBeenCalled();
  });
});


it('does not persist a queued old cookie after logout changes the generation', async () => {
  let value: string | null = 'saved-session'; let release!: () => void; let respondFirst!: (value: Response) => void; let respondSecond!: (value: Response) => void;
  const storage = { get: async () => value, set: vi.fn((next: string) => new Promise<void>((resolve) => { release = () => { value = next; resolve(); }; })), clear: vi.fn(async () => { value = null; }) };
  const codecCheck = vi.fn(() => true);
  const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise<Response>((resolve) => { respondFirst = resolve; })).mockReturnValueOnce(new Promise<Response>((resolve) => { respondSecond = resolve; }));
  const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, { ...codec, hasBetterAuthCookies: codecCheck }, fetcher);
  const first = api.request('/profile'); const second = api.request('/health');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  respondFirst(json({}, 200, { 'set-cookie': 'ageniza.session_token=first' }));
  await vi.waitFor(() => expect(storage.set).toHaveBeenCalledOnce());
  respondSecond(json({}, 200, { 'set-cookie': 'ageniza.session_token=second' }));
  await vi.waitFor(() => expect(codecCheck).toHaveBeenCalledTimes(2));
  const clearing = api.clearSession(); release();
  await expect(first).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await expect(second).rejects.toMatchObject({ code: 'STALE_SESSION' });
  await clearing;
  expect(storage.set).toHaveBeenCalledTimes(1); expect(await storage.get()).toBeNull();
});


describe('web mobile confirmation destination', () => {
  it.each(['/auth/sign-up', '/auth/email/verification/resend'])('marks %s only on the web client', async (path) => {
    for (const native of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}));
      const api = createApiClient('https://dev.ageniza.com.br/api', memory(), native, codec, fetcher);
      await api.request(path, { method: 'POST', body: {} });
      expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-ageniza-client')).toBe(native ? null : 'mobile-web');
    }
  });
  it('does not add a destination hint to login or business requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const api = createApiClient('https://dev.ageniza.com.br/api', memory(), false, codec, fetcher);
    await api.request('/auth/login', { method: 'POST', body: {} });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('x-ageniza-client')).toBe(false);
  });
});
