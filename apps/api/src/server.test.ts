import { afterEach, describe, expect, it, vi } from 'vitest';

import { startApi } from './server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Issue #772: the simulated payment provider is a development tool. The API in production refuses to start with it, before it
// opens a connection, and says which setting it refused.
describe('API startup and the payment provider', () => {
  it('refuses to start in production with PAYMENTS_PROVIDER=simulado', async () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://ageniza_app:password@postgres:5432/ageniza');
    vi.stubEnv('BETTER_AUTH_SECRET', 'not-a-real-secret-only-for-this-test-0123456789');
    vi.stubEnv('AUTH_TERMS_VERSION', '2026-01-01');
    vi.stubEnv('AUTH_PRIVACY_VERSION', '2026-01-01');
    vi.stubEnv('APP_PUBLIC_URL', 'https://app.ageniza.example');
    vi.stubEnv('PAYMENTS_PROVIDER', 'simulado');
    await expect(startApi()).rejects.toThrow('PAYMENTS_PROVIDER');
  });
});
