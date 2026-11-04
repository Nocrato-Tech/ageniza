import { afterEach, describe, expect, it, vi } from 'vitest';
const environment = vi.hoisted(() => ({ platform: 'android' }));
const nativeFetch = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn<(...args: unknown[]) => object>(() => ({})));
vi.mock('react-native', () => ({ Platform: { get OS() { return environment.platform; } } }));
vi.mock('expo/fetch', () => ({ fetch: nativeFetch }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@better-auth/expo/client', () => ({ getCookie: vi.fn(), getSetCookie: vi.fn(), hasBetterAuthCookies: vi.fn() }));
vi.mock('./client', () => ({ createApiClient: create }));
afterEach(() => { vi.resetModules(); create.mockClear(); });
describe('runtime transport wiring', () => {
  it.each(['android', 'ios'])('uses redirect-safe Expo fetch on %s', async (platform) => {
    environment.platform = platform;
    await import('./runtime');
    expect(create.mock.calls[0]?.[2]).toBe(true);
    expect(create.mock.calls[0]?.[4]).toBe(nativeFetch);
  });
  it('uses browser fetch only on web', async () => {
    environment.platform = 'web';
    await import('./runtime');
    expect(create.mock.calls[0]?.[2]).toBe(false);
    expect(create.mock.calls[0]?.[4]).toBe(fetch);
  });
});
