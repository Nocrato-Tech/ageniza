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
    expect(loadApiConfig(localEnvironment)).toMatchObject({
      service: 'api', environment: 'local', host: '0.0.0.0', port: 3001, corsOrigins: ['http://127.0.0.1:5173'], bodyLimitBytes: 1_048_576, trustedProxyCidrs: []
    });
    expect(loadWorkerConfig(localEnvironment)).toEqual({
      service: 'worker',
      environment: 'local',
      databaseUrl: localEnvironment.DATABASE_URL,
      supabaseUrl: localEnvironment.SUPABASE_URL,
      supabaseServiceRoleKey: localEnvironment.SUPABASE_SERVICE_ROLE_KEY,
      healthHost: '127.0.0.1',
      healthPort: 3002,
      smokeJob: false
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
        SUPABASE_URL: 'https://project.supabase.co',
        API_CORS_ORIGINS: 'https://app.ageniza.example'
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

  it('loads explicit API bootstrap settings without allowing a wildcard proxy trust', () => {
    expect(loadApiConfig({
      ...localEnvironment,
      API_HOST: '127.0.0.1',
      API_CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:4173',
      API_BODY_LIMIT_BYTES: '4096',
      API_TRUSTED_PROXY_CIDRS: '127.0.0.1,10.0.0.0/8'
    })).toMatchObject({
      host: '127.0.0.1', corsOrigins: ['http://127.0.0.1:5173', 'http://localhost:4173'], bodyLimitBytes: 4096,
      trustedProxyCidrs: ['127.0.0.1', '10.0.0.0/8']
    });
    expect(() => loadApiConfig({ ...localEnvironment, API_TRUSTED_PROXY_CIDRS: '*' })).toThrow('explicit proxy networks');
    expect(() => loadApiConfig({ ...localEnvironment, API_TRUSTED_PROXY_CIDRS: 'not-a-network' })).toThrow('valid IP addresses or CIDR networks');
    expect(() => loadApiConfig({ ...localEnvironment, API_TRUSTED_PROXY_CIDRS: '10.0.0.0/33' })).toThrow('valid IP addresses or CIDR networks');
  });

  it('keeps worker probes loopback-only and smoke mode out of production', () => {
    expect(loadWorkerConfig({
      ...localEnvironment,
      WORKER_HEALTH_HOST: '::1',
      WORKER_HEALTH_PORT: '4012',
      WORKER_SMOKE_JOB: 'true'
    })).toMatchObject({ healthHost: '::1', healthPort: 4012, smokeJob: true });
    expect(() => loadWorkerConfig({ ...localEnvironment, WORKER_HEALTH_HOST: '0.0.0.0' })).toThrow('WORKER_HEALTH_HOST');
    expect(() => loadWorkerConfig({ ...localEnvironment, WORKER_HEALTH_PORT: '0' })).toThrow('WORKER_HEALTH_PORT');
    expect(() => loadWorkerConfig({ ...localEnvironment, WORKER_SMOKE_JOB: 'yes' })).toThrow('WORKER_SMOKE_JOB');
    expect(() => loadWorkerConfig({
      ...localEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://app:password@database.example.com:5432/ageniza',
      SUPABASE_URL: 'https://project.supabase.co',
      WORKER_SMOKE_JOB: 'true'
    })).toThrow('must be false in production');
  });
});
