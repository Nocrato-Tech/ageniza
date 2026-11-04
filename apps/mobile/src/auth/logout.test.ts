import { expect, it, vi } from 'vitest';
import { createApiClient } from '../api/client';
import { logoutLocally } from './logout';

it('clears local access and expires the UI when server revocation is offline', async () => {
  let saved: string | null = 'saved';
  const storage = { get: async () => saved, set: async (value: string) => { saved = value; }, clear: async () => { saved = null; } };
  const codec = { getCookie: () => '', getSetCookie: () => '', hasBetterAuthCookies: () => false };
  const api = createApiClient('https://dev.ageniza.com.br/api', storage, true, codec, vi.fn().mockRejectedValue(new Error('offline')));
  const expire = vi.fn();
  await expect(logoutLocally(api, expire)).resolves.toEqual({ revocationFailed: true });
  expect(saved).toBeNull(); expect(expire).toHaveBeenCalledOnce();
});
