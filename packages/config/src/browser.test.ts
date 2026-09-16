import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadWebConfig, type BrowserEnvironment } from './browser.js';

const localEnvironment: BrowserEnvironment = {
  MODE: 'development',
  VITE_API_BASE_URL: 'http://127.0.0.1:3001',
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY: 'local-anon-key'
};

describe('browser configuration', () => {
  it('maps Vite development mode to the local runtime', () => {
    expect(loadWebConfig(localEnvironment)).toMatchObject({ environment: 'local', apiBaseUrl: 'http://127.0.0.1:3001' });
  });

  it('supports Vite test mode', () => {
    expect(loadWebConfig({ ...localEnvironment, MODE: 'test' }).environment).toBe('test');
  });

  it('supports production mode only with an HTTPS Supabase URL', () => {
    const productionEnvironment = {
      ...localEnvironment,
      MODE: 'production',
      VITE_API_BASE_URL: 'https://api.ageniza.example',
      VITE_SUPABASE_URL: 'https://project.supabase.co'
    };
    expect(loadWebConfig(productionEnvironment).environment).toBe('production');
    expect(() => loadWebConfig({ ...productionEnvironment, VITE_SUPABASE_URL: 'http://project.supabase.co' })).toThrow(
      'must use HTTPS in production'
    );
  });

  it('requires HTTPS public Sentry DSNs in production', () => {
    const productionEnvironment = { ...localEnvironment, MODE: 'production', VITE_API_BASE_URL: 'https://api.ageniza.example', VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SENTRY_DSN: 'https://public@sentry.example/1' };
    expect(loadWebConfig(productionEnvironment).sentryDsn).toBe('https://public@sentry.example/1');
    expect(() => loadWebConfig({ ...productionEnvironment, VITE_SENTRY_DSN: 'http://public@sentry.example/1' })).toThrow('must use HTTPS');
  });

  it('treats a blank optional public Sentry DSN as disabled', () => {
    expect(loadWebConfig({ ...localEnvironment, VITE_SENTRY_DSN: '  ' }).sentryDsn).toBeUndefined();
  });

  it('fails fast for missing or invalid public configuration', () => {
    expect(() => loadWebConfig({ MODE: 'development' })).toThrow(ConfigValidationError);
    expect(() => loadWebConfig({ ...localEnvironment, VITE_API_BASE_URL: 'relative-url' })).toThrow('VITE_API_BASE_URL');
  });

  it('rejects staging mode and remote Supabase in local mode', () => {
    expect(() => loadWebConfig({ ...localEnvironment, MODE: 'staging' })).toThrow('staging is not modeled');
    expect(() => loadWebConfig({ ...localEnvironment, VITE_SUPABASE_URL: 'https://project.supabase.co' })).toThrow(
      'must point to a loopback resource'
    );
    expect(() => loadWebConfig({ ...localEnvironment, MODE: 'test', VITE_API_BASE_URL: 'https://ci.example.com' })).toThrow(
      'must point to a loopback resource'
    );
  });

  it('does not expose server secrets even when they exist in the source environment', () => {
    const config = loadWebConfig({
      ...localEnvironment,
      DATABASE_URL: 'postgresql://secret@remote.example.com:5432/app',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret'
    });

    expect(Object.keys(config)).toEqual(['environment', 'apiBaseUrl', 'supabaseUrl', 'supabaseAnonKey', 'sentryDsn', 'deployVersion']);
    expect(JSON.stringify(config)).not.toContain('server-only-secret');
    expect(JSON.stringify(config)).not.toContain('postgresql://secret');
  });
});
