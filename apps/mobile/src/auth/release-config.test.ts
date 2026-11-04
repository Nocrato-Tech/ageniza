import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const configure = require('../../app.config.js') as () => { name: string; android: { package: string } };
afterEach(() => vi.unstubAllEnvs());
describe('release environment', () => {
  it('uses a fixed same-origin web path without changing native or default exports', () => {
    expect(configure()).not.toHaveProperty('experiments.baseUrl');
    vi.stubEnv('MOBILE_WEB_BASE_PATH', '/app-mobile');
    expect(configure()).toHaveProperty('experiments.baseUrl', '/app-mobile');
    vi.stubEnv('MOBILE_WEB_BASE_PATH', '//external.example');
    expect(configure).toThrow('supported web base path');
  });

  it('does not silently send a production build to the dev backend', () => {
    vi.stubEnv('APP_VARIANT', 'production'); vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    expect(configure).toThrow('explicit');
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'https://dev.ageniza.com.br/api');
    expect(configure).toThrow('production API');
  });
  it.each(['http://api.ageniza.example/api', 'https://user:secret@api.ageniza.example/api', 'https://api.ageniza.example/api?token=secret'])('rejects unsafe production targets', (url) => {
    vi.stubEnv('APP_VARIANT', 'production'); vi.stubEnv('EXPO_PUBLIC_API_URL', url);
    expect(configure).toThrow();
  });
  it('uses a separate application id for an internal build', () => {
    vi.stubEnv('APP_VARIANT', 'internal'); vi.stubEnv('EAS_BUILD_PROFILE', 'preview');
    expect(configure()).toMatchObject({ name: 'Ageniza Interno', android: { package: 'com.ageniza.mobile.internal' } });
  });
});
