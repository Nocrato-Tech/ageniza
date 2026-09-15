import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadApiConfig, loadWorkerConfig } from './server.js';

const localEnvironment = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'local-service-role-key'
};

describe('server configuration', () => {
  it('loads typed local API and worker configuration', () => {
    expect(loadApiConfig(localEnvironment)).toMatchObject({ service: 'api', environment: 'local', port: 3001 });
    expect(loadWorkerConfig(localEnvironment)).toEqual({
      service: 'worker',
      environment: 'local',
      databaseUrl: localEnvironment.DATABASE_URL,
      supabaseUrl: localEnvironment.SUPABASE_URL,
      supabaseServiceRoleKey: localEnvironment.SUPABASE_SERVICE_ROLE_KEY
    });
  });

  it('fails when required server configuration is missing', () => {
    expect(() => loadApiConfig({ APP_ENV: 'local' })).toThrow(ConfigValidationError);
    expect(() => loadApiConfig({ APP_ENV: 'local' })).toThrow('DATABASE_URL');
  });

  it('fails for invalid configuration without exposing supplied secret values', () => {
    const secret = 'should-never-appear-in-errors';
    expect(() => loadApiConfig({ ...localEnvironment, DATABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: secret })).toThrow(
      'DATABASE_URL'
    );
    try {
      loadApiConfig({ ...localEnvironment, DATABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('redacted');
    }
  });

  it('rejects staging and develop as runtimes', () => {
    expect(() => loadApiConfig({ ...localEnvironment, APP_ENV: 'staging' })).toThrow('staging is not modeled');
    expect(() => loadApiConfig({ ...localEnvironment, APP_ENV: 'develop' })).toThrow('develop is a Git branch');
  });

  it('supports CI as an isolated local test runtime', () => {
    expect(loadApiConfig({ ...localEnvironment, APP_ENV: 'ci' }).environment).toBe('test');
    expect(() => loadApiConfig({ ...localEnvironment, APP_ENV: 'ci', SUPABASE_URL: 'https://project.supabase.co' })).toThrow(
      'must point to a loopback resource'
    );
  });

  it('allows HTTPS production resources and rejects insecure production Supabase URLs', () => {
    expect(
      loadApiConfig({
        ...localEnvironment,
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://app:password@database.example.com:5432/ageniza',
        SUPABASE_URL: 'https://project.supabase.co'
      }).environment
    ).toBe('production');
    expect(() => loadApiConfig({ ...localEnvironment, APP_ENV: 'production', SUPABASE_URL: 'http://project.supabase.co' })).toThrow(
      'must use HTTPS in production'
    );
  });

  it('prevents local processes from using remote Supabase or database resources', () => {
    expect(() => loadApiConfig({ ...localEnvironment, SUPABASE_URL: 'https://project.supabase.co' })).toThrow(
      'must point to a loopback resource'
    );
    expect(() => loadApiConfig({ ...localEnvironment, DATABASE_URL: 'postgresql://user:password@db.example.com:5432/app' })).toThrow(
      'must point to a loopback resource'
    );
  });
});
