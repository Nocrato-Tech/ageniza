import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigValidationError, loadApiConfig, loadWorkerConfig } from './server.js';

const localEnvironment = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
  BETTER_AUTH_SECRET: 'local-development-placeholder-secret-change-me',
  APP_PUBLIC_URL: 'http://127.0.0.1:5173',
  AUTH_TERMS_VERSION: '2026-01-01',
  AUTH_PRIVACY_VERSION: '2026-02-01'
};

const productionDatabaseUrl = 'postgresql://ageniza_app:password@postgres:5432/ageniza';
// A production-shaped Better Auth secret that deliberately avoids every B11 example marker
// (placeholder/change-me/changeme/replace/example/test), unlike `localEnvironment`'s own secret.
const productionAuthSecret = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4a1b2c3d4e5f6';
const productionEmailSettings = {
  SMTP_URL: 'smtps://user:key@smtp.ageniza.example:465',
  EMAIL_FROM: 'no-reply@ageniza.example'
};
const productionStorageSettings = {
  R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'production-access-key-id',
  R2_SECRET_ACCESS_KEY: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4a1b2c3d4e5f6',
  R2_BUCKET: 'ageniza-media'
};
const productionIdentityStorageSettings = {
  IDENTITY_STORAGE_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  IDENTITY_STORAGE_ACCESS_KEY_ID: 'production-identity-access-key-id',
  IDENTITY_STORAGE_SECRET_ACCESS_KEY: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4a1b2c3d4e5f6a1',
  IDENTITY_STORAGE_BUCKET: 'ageniza-identity'
};

describe('server configuration', () => {
  it('loads typed local API and worker configuration', () => {
    expect(loadApiConfig(localEnvironment)).toMatchObject({
      service: 'api', environment: 'local', authSecret: localEnvironment.BETTER_AUTH_SECRET, appPublicUrl: localEnvironment.APP_PUBLIC_URL,
      authTermsVersion: '2026-01-01', authPrivacyVersion: '2026-02-01',
      host: '0.0.0.0', port: 3001, corsOrigins: ['http://127.0.0.1:5173'], bodyLimitBytes: 1_048_576, trustedProxyCidrs: [],
      containerLocal: false
    });
    // The local Compose stack runs the production image with this flag; the API uses it to keep
    // host-only tooling such as /docs from loading devDependencies the image does not have.
    expect(loadApiConfig({ ...localEnvironment, APP_CONTAINER_LOCAL: 'true' })).toMatchObject({ containerLocal: true });
    expect(loadWorkerConfig(localEnvironment)).toEqual({
      service: 'worker',
      environment: 'local',
      databaseUrl: localEnvironment.DATABASE_URL,
      healthHost: '127.0.0.1',
      healthPort: 3002,
      smokeJob: false,
      appPublicUrl: localEnvironment.APP_PUBLIC_URL,
      concurrency: 1,
      sentryDsn: undefined,
      deployVersion: 'unknown',
      smtpUrl: undefined,
      emailFrom: undefined,
      storage: undefined,
      mediaProcessing: {
        ffmpegTimeoutSeconds: 240,
        maxDurationSeconds: 1_800,
        thumbnailWidthPixels: 640,
        previewMaxHeightPixels: 720,
        previewMaxOutputBytes: 300 * 1024 * 1024
      }
    });
  });

  it('accepts transactional email settings only as a complete, local-safe pair', () => {
    const withEmail = { ...localEnvironment, SMTP_URL: 'smtp://mailpit:1025', EMAIL_FROM: 'Ageniza <no-reply@ageniza.example>', APP_CONTAINER_LOCAL: 'true' };
    expect(loadApiConfig(withEmail)).toMatchObject({ smtpUrl: 'smtp://mailpit:1025', emailFrom: 'Ageniza <no-reply@ageniza.example>' });
    expect(() => loadApiConfig({ ...withEmail, EMAIL_FROM: undefined })).toThrow('EMAIL_FROM');
    expect(() => loadApiConfig({ ...localEnvironment, EMAIL_FROM: 'no-reply@ageniza.example' })).toThrow('SMTP_URL');
    expect(() => loadApiConfig({ ...withEmail, SMTP_URL: 'https://mail.example.com' })).toThrow('smtp');
    expect(() => loadApiConfig({ ...withEmail, SMTP_URL: 'smtp://smtp.example.com:587' })).toThrow('must point to a loopback resource');
    expect(loadApiConfig({
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      SMTP_URL: 'smtps://user:key@smtp.example.com:465',
      EMAIL_FROM: 'no-reply@ageniza.example',
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    }).smtpUrl).toBe('smtps://user:key@smtp.example.com:465');
  });

  it('fails when required server configuration is missing', () => {
    expect(() => loadApiConfig({ APP_ENV: 'local' })).toThrow(ConfigValidationError);
    expect(() => loadApiConfig({ APP_ENV: 'local' })).toThrow('DATABASE_URL');
  });

  it('requires independent terms and privacy document versions in YYYY-MM-DD format', () => {
    expect(() => loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: undefined })).toThrow('AUTH_TERMS_VERSION');
    expect(() => loadApiConfig({ ...localEnvironment, AUTH_PRIVACY_VERSION: undefined })).toThrow('AUTH_PRIVACY_VERSION');
    expect(() => loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: '2026-1-01' })).toThrow('YYYY-MM-DD');
    expect(() => loadApiConfig({ ...localEnvironment, AUTH_PRIVACY_VERSION: 'not-a-date' })).toThrow('YYYY-MM-DD');
    expect(loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: '2025-12-31', AUTH_PRIVACY_VERSION: '2026-01-01' })).toMatchObject({
      authTermsVersion: '2025-12-31', authPrivacyVersion: '2026-01-01'
    });
  });

  it('refuses a document version that is not a real date or lies in the future (issue #81 security review)', () => {
    for (const name of ['AUTH_TERMS_VERSION', 'AUTH_PRIVACY_VERSION'] as const) {
      for (const impossible of ['2026-02-30', '2026-99-99', '2026-13-01', '2026-00-10', '0000-01-01', '2025-02-29']) {
        expect(() => loadApiConfig({ ...localEnvironment, [name]: impossible }), `${name} ${impossible}`).toThrow('real calendar date');
      }
      expect(() => loadApiConfig({ ...localEnvironment, [name]: '9999-12-31' }), name).toThrow('future');
      const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      expect(() => loadApiConfig({ ...localEnvironment, [name]: tomorrow }), name).toThrow('future');
    }
    // A leap day is a real date, and the day the product is in today is accepted.
    expect(loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: '2024-02-29' })).toMatchObject({ authTermsVersion: '2024-02-29' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    expect(loadApiConfig({ ...localEnvironment, AUTH_PRIVACY_VERSION: today })).toMatchObject({ authPrivacyVersion: today });
  });

  // Issue #373. The clock cannot be left to the wall time: between 21:00 and 24:00 in Brasília its date and the UTC date
  // differ, and only a pinned instant inside that window tells America/Sao_Paulo from UTC (or from the zone of the process).
  describe('the day a document version is compared with, in America/Sao_Paulo', () => {
    const originalZone = process.env.TZ;
    afterEach(() => {
      vi.useRealTimers();
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
    });

    // A worker thread cannot change the zone of the process, and every case would then run in the same one without failing.
    const setProcessZone = (zone: string): void => {
      process.env.TZ = zone;
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    };

    const accepts = (version: string): boolean => {
      try {
        loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: version });
        return true;
      } catch (error) {
        if (error instanceof ConfigValidationError && error.message.includes('must not be in the future')) return false;
        throw error;
      }
    };

    // 2026-10-07 22:00 in Brasília is 2026-10-08 01:00 UTC: the version dated the 8th is still tomorrow for the product.
    it.each(['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo'])('at 22:00 in Brasília refuses the next day and accepts today, whatever the zone of the process (%s)', (zone) => {
      setProcessZone(zone);
      vi.useFakeTimers({ now: new Date('2026-10-08T01:00:00Z') });

      expect(accepts('2026-10-07')).toBe(true);
      expect(accepts('2026-10-08')).toBe(false);
      expect(accepts('2026-10-09')).toBe(false);
    });

    it('turns the day exactly at Brasília midnight, 03:00 UTC', () => {
      setProcessZone('UTC');
      vi.useFakeTimers({ now: new Date('2026-10-08T02:59:59.999Z') });
      expect(accepts('2026-10-08')).toBe(false);

      vi.setSystemTime(new Date('2026-10-08T03:00:00Z'));
      expect(accepts('2026-10-08')).toBe(true);
      expect(accepts('2026-10-09')).toBe(false);
    });
  });

  it('requires a sufficiently long Better Auth secret without exposing supplied values', () => {
    const supplied = 'short-secret-value';
    expect(() => loadApiConfig({ ...localEnvironment, BETTER_AUTH_SECRET: undefined })).toThrow('BETTER_AUTH_SECRET');
    expect(() => loadApiConfig({ ...localEnvironment, BETTER_AUTH_SECRET: supplied })).toThrow('32 characters');
    try {
      loadApiConfig({ ...localEnvironment, BETTER_AUTH_SECRET: supplied });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).toContain('BETTER_AUTH_SECRET');
      expect((error as Error).message).not.toContain(supplied);
      expect((error as Error).message).toContain('redacted');
    }
  });

  it('requires APP_PUBLIC_URL to be a loopback origin locally and HTTPS in production', () => {
    expect(() => loadApiConfig({ ...localEnvironment, APP_PUBLIC_URL: 'http://127.0.0.1:5173/login' })).toThrow('origin without paths');
    expect(() => loadApiConfig({ ...localEnvironment, APP_PUBLIC_URL: 'https://app.ageniza.example' })).toThrow('must point to a loopback resource');

    const production = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    };
    expect(() => loadApiConfig({ ...production, APP_PUBLIC_URL: 'http://app.ageniza.example' })).toThrow('must use HTTPS');
    expect(loadApiConfig({ ...production, APP_PUBLIC_URL: 'https://app.ageniza.example' }).appPublicUrl).toBe('https://app.ageniza.example');
  });

  it('fails for invalid configuration without exposing supplied secret values', () => {
    const secret = 'should-never-appear-in-errors';
    expect(() => loadApiConfig({ ...localEnvironment, DATABASE_URL: `not a url ${secret}` })).toThrow('DATABASE_URL');
    try {
      loadApiConfig({ ...localEnvironment, DATABASE_URL: `not a url ${secret}` });
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
    expect(() => loadApiConfig({ ...localEnvironment, APP_ENV: 'ci', DATABASE_URL: 'postgresql://app:password@db.example.com:5432/app' })).toThrow(
      'must point to a loopback resource'
    );
  });

  it('requires HTTPS Sentry DSNs in production', () => {
    const production = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      SENTRY_DSN: 'https://public@sentry.example/1',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    };
    expect(loadApiConfig(production).sentryDsn).toBe('https://public@sentry.example/1');
    expect(() => loadApiConfig({ ...production, SENTRY_DSN: 'http://public@sentry.example/1' })).toThrow('must use HTTPS');
  });

  it('treats a blank optional Sentry DSN as disabled', () => {
    expect(loadApiConfig({ ...localEnvironment, SENTRY_DSN: '  ' }).sentryDsn).toBeUndefined();
    expect(loadWorkerConfig({ ...localEnvironment, SENTRY_DSN: '' }).sentryDsn).toBeUndefined();
  });

  it('accepts the internal production database and rejects a loopback one', () => {
    expect(loadApiConfig({
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    }).environment).toBe('production');
    expect(() => loadApiConfig({
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings
    })).toThrow(
      'must not point to a loopback resource in production'
    );
  });

  it('prevents local processes from using a remote database', () => {
    expect(() => loadApiConfig({ ...localEnvironment, DATABASE_URL: 'postgresql://user:password@db.example.com:5432/app' })).toThrow(
      'must point to a loopback resource'
    );
  });

  it('permits only the local Compose database hosts in container-local mode', () => {
    const containerEnvironment = { ...localEnvironment, APP_CONTAINER_LOCAL: 'true', DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@postgres:5432/ageniza' };
    expect(loadWorkerConfig(containerEnvironment).databaseUrl).toContain('@postgres:5432');
    expect(loadWorkerConfig({ ...containerEnvironment, DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@host.docker.internal:54322/ageniza' }).databaseUrl).toContain('host.docker.internal');
    expect(() => loadWorkerConfig({ ...containerEnvironment, APP_CONTAINER_LOCAL: 'false' })).toThrow(ConfigValidationError);
    expect(() => loadWorkerConfig({ ...containerEnvironment, DATABASE_URL: 'postgresql://postgres:postgres@db.example.test:5432/postgres' })).toThrow(ConfigValidationError);
    expect(() => loadWorkerConfig({ ...containerEnvironment, APP_ENV: 'production', DATABASE_URL: productionDatabaseUrl })).toThrow('APP_CONTAINER_LOCAL');
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

  it('requires SMTP_URL and EMAIL_FROM in production but keeps them optional locally (M2)', () => {
    const productionWithoutEmail = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example'
    };
    expect(() => loadApiConfig(productionWithoutEmail)).toThrow('SMTP_URL and EMAIL_FROM are required');
    expect(() => loadApiConfig({ ...productionWithoutEmail, SMTP_URL: productionEmailSettings.SMTP_URL })).toThrow(
      'must be set together with EMAIL_FROM'
    );
    expect(loadApiConfig({ ...productionWithoutEmail, ...productionEmailSettings, ...productionStorageSettings, ...productionIdentityStorageSettings }).smtpUrl).toBe(productionEmailSettings.SMTP_URL);
    // Local/test stay unaffected: SMTP remains fully optional there.
    expect(loadApiConfig(localEnvironment).smtpUrl).toBeUndefined();
  });

  it('rejects an example/placeholder-looking BETTER_AUTH_SECRET in production without exposing it (B11)', () => {
    const production = {
      ...localEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    };
    // localEnvironment's own secret contains both "placeholder" and "change-me".
    expect(() => loadApiConfig(production)).toThrow('BETTER_AUTH_SECRET');
    for (const marker of ['placeholder', 'change-me', 'changeme', 'replace', 'example', 'test', 'PLACEHOLDER', 'Example']) {
      const secret = `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4-${marker}`;
      expect(() => loadApiConfig({ ...production, BETTER_AUTH_SECRET: secret })).toThrow(ConfigValidationError);
    }
    try {
      loadApiConfig(production);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).not.toContain(localEnvironment.BETTER_AUTH_SECRET);
      expect((error as Error).message).toContain('redacted');
    }
    // A secret with no example marker is accepted.
    expect(loadApiConfig({ ...production, BETTER_AUTH_SECRET: productionAuthSecret }).authSecret).toBe(productionAuthSecret);
    // The same placeholder secret is still fine outside production.
    expect(loadApiConfig(localEnvironment).authSecret).toBe(localEnvironment.BETTER_AUTH_SECRET);
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
    expect(loadWorkerConfig({ ...localEnvironment, WORKER_CONCURRENCY: '2' }).concurrency).toBe(2);
    expect(loadWorkerConfig({ ...localEnvironment, WORKER_CONCURRENCY: '4' }).concurrency).toBe(4);
    expect(() => loadWorkerConfig({ ...localEnvironment, WORKER_CONCURRENCY: '0' })).toThrow('WORKER_CONCURRENCY');
    expect(() => loadWorkerConfig({ ...localEnvironment, WORKER_CONCURRENCY: '5' })).toThrow('WORKER_CONCURRENCY');
    expect(() => loadWorkerConfig({
      ...localEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      WORKER_SMOKE_JOB: 'true'
    })).toThrow('must be false in production');
  });

  it('gives the worker the origin of the web app for the portal links of the client e-mail, and requires the three e-mail settings in production (issue #260)', () => {
    expect(loadWorkerConfig({ ...localEnvironment, APP_PUBLIC_URL: undefined }).appPublicUrl).toBeUndefined();
    expect(loadWorkerConfig({ ...localEnvironment, APP_PUBLIC_URL: '' }).appPublicUrl).toBeUndefined();
    expect(() => loadWorkerConfig({ ...localEnvironment, APP_PUBLIC_URL: 'http://127.0.0.1:5173/login' })).toThrow('origin without paths');
    expect(() => loadWorkerConfig({ ...localEnvironment, APP_PUBLIC_URL: 'http://127.0.0.1:5173/?token=x' })).toThrow('origin without paths');

    const production = {
      ...localEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings
    };
    expect(loadWorkerConfig(production).appPublicUrl).toBe('https://app.ageniza.example');
    expect(() => loadWorkerConfig({ ...production, APP_PUBLIC_URL: 'http://app.ageniza.example' })).toThrow('must use HTTPS');
    for (const missing of ['APP_PUBLIC_URL', 'SMTP_URL', 'EMAIL_FROM']) {
      expect(() => loadWorkerConfig({ ...production, [missing]: '' })).toThrow(ConfigValidationError);
    }
    // Both e-mail settings gone at once: the rule of the pair must still refuse, not only the one-at-a-time loop above.
    expect(() => loadWorkerConfig({ ...production, SMTP_URL: undefined, EMAIL_FROM: undefined })).toThrow('APP_PUBLIC_URL, SMTP_URL and EMAIL_FROM are required in production');
  });

  it('leaves storage undefined locally and loads it with defaults when the four R2 settings are present (issue #21)', () => {
    expect(loadApiConfig(localEnvironment).storage).toBeUndefined();
    const withStorage = {
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      R2_ENDPOINT: 'http://localstack:4566',
      R2_ACCESS_KEY_ID: 'local-access-key',
      R2_SECRET_ACCESS_KEY: 'local-secret-key'
    };
    expect(() => loadApiConfig(withStorage)).toThrow('must be set together');
    expect(loadApiConfig({ ...withStorage, R2_BUCKET: 'ageniza-media-local' }).storage).toMatchObject({
      endpoint: 'http://localstack:4566',
      region: 'auto',
      accessKeyId: 'local-access-key',
      secretAccessKey: 'local-secret-key',
      bucket: 'ageniza-media-local',
      forcePathStyle: true,
      uploadUrlExpirySeconds: 900,
      downloadUrlExpirySeconds: 300,
      multipartThresholdBytes: 8 * 1024 * 1024,
      multipartPartBytes: 8 * 1024 * 1024,
      maxImageBytes: 25 * 1024 * 1024,
      maxVideoBytes: 5 * 1024 * 1024 * 1024,
      quotaDefaultBytes: 10 * 1024 * 1024 * 1024,
      quotaDefaultObjectCount: 2_000
    });
  });

  it('requires the four R2 settings together in production and rejects a placeholder secret (issue #21)', () => {
    const productionWithoutStorage = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings
    };
    expect(() => loadApiConfig(productionWithoutStorage)).toThrow('required in production');
    expect(() => loadApiConfig({ ...productionWithoutStorage, R2_ENDPOINT: productionStorageSettings.R2_ENDPOINT })).toThrow('must be set together');
    expect(loadApiConfig({ ...productionWithoutStorage, ...productionStorageSettings, ...productionIdentityStorageSettings }).storage?.bucket).toBe('ageniza-media');
    expect(() => loadApiConfig({ ...productionWithoutStorage, ...productionStorageSettings, R2_ENDPOINT: 'http://accountid.r2.cloudflarestorage.com' })).toThrow('HTTPS');
    for (const marker of ['placeholder', 'change-me', 'example']) {
      expect(() => loadApiConfig({
        ...productionWithoutStorage,
        ...productionStorageSettings,
        R2_SECRET_ACCESS_KEY: `a1b2c3d4e5f6a1b2c3d4e5f6-${marker}`
      })).toThrow(ConfigValidationError);
    }
  });

  it('leaves worker storage undefined locally, loads it with the four R2 settings, and requires them together in production (issue #24)', () => {
    expect(loadWorkerConfig(localEnvironment).storage).toBeUndefined();
    const withStorage = {
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      R2_ENDPOINT: 'http://localstack:4566',
      R2_ACCESS_KEY_ID: 'local-access-key',
      R2_SECRET_ACCESS_KEY: 'local-secret-key'
    };
    expect(() => loadWorkerConfig(withStorage)).toThrow('must be set together');
    expect(loadWorkerConfig({ ...withStorage, R2_BUCKET: 'ageniza-media-local' }).storage).toEqual({
      endpoint: 'http://localstack:4566',
      region: 'auto',
      accessKeyId: 'local-access-key',
      secretAccessKey: 'local-secret-key',
      bucket: 'ageniza-media-local',
      forcePathStyle: true
    });

    const productionWithoutStorage = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      ...productionEmailSettings
    };
    expect(() => loadWorkerConfig(productionWithoutStorage)).toThrow('required in production');
    expect(loadWorkerConfig({ ...productionWithoutStorage, ...productionStorageSettings }).storage?.bucket).toBe('ageniza-media');
    expect(() => loadWorkerConfig({ ...productionWithoutStorage, ...productionStorageSettings, R2_ENDPOINT: 'http://accountid.r2.cloudflarestorage.com' })).toThrow('HTTPS');
    expect(() => loadWorkerConfig({
      ...productionWithoutStorage,
      ...productionStorageSettings,
      R2_SECRET_ACCESS_KEY: 'a1b2c3d4e5f6a1b2c3d4e5f6-placeholder'
    })).toThrow(ConfigValidationError);
  });

  it('loads media processing defaults and honors overrides (issue #24)', () => {
    expect(loadWorkerConfig({
      ...localEnvironment,
      MEDIA_PROCESSING_TIMEOUT_SECONDS: '120',
      MEDIA_PROCESSING_MAX_DURATION_SECONDS: '600',
      MEDIA_THUMBNAIL_WIDTH_PIXELS: '320',
      MEDIA_PREVIEW_MAX_HEIGHT_PIXELS: '480',
      MEDIA_PREVIEW_MAX_OUTPUT_BYTES: String(50 * 1024 * 1024)
    }).mediaProcessing).toEqual({
      ffmpegTimeoutSeconds: 120,
      maxDurationSeconds: 600,
      thumbnailWidthPixels: 320,
      previewMaxHeightPixels: 480,
      previewMaxOutputBytes: 50 * 1024 * 1024
    });
  });

  it('rejects a multipart part size larger than the multipart threshold (issue #21)', () => {
    expect(() => loadApiConfig({
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      R2_ENDPOINT: 'http://localstack:4566',
      R2_ACCESS_KEY_ID: 'local-access-key',
      R2_SECRET_ACCESS_KEY: 'local-secret-key',
      R2_BUCKET: 'ageniza-media-local',
      MEDIA_MULTIPART_THRESHOLD_BYTES: String(8 * 1024 * 1024),
      MEDIA_MULTIPART_PART_BYTES: String(16 * 1024 * 1024)
    })).toThrow('MEDIA_MULTIPART_PART_BYTES');
  });

  it('leaves identity storage undefined locally and loads it with defaults when the four settings are present (issue #100)', () => {
    expect(loadApiConfig(localEnvironment).identityStorage).toBeUndefined();
    const withIdentityStorage = {
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      IDENTITY_STORAGE_ENDPOINT: 'http://localstack:4566',
      IDENTITY_STORAGE_ACCESS_KEY_ID: 'local-access-key',
      IDENTITY_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key'
    };
    expect(() => loadApiConfig(withIdentityStorage)).toThrow('must be set together');
    expect(loadApiConfig({ ...withIdentityStorage, IDENTITY_STORAGE_BUCKET: 'ageniza-identity-local' }).identityStorage).toMatchObject({
      endpoint: 'http://localstack:4566',
      publicEndpoint: 'http://localstack:4566',
      region: 'auto',
      accessKeyId: 'local-access-key',
      secretAccessKey: 'local-secret-key',
      bucket: 'ageniza-identity-local',
      forcePathStyle: true,
      downloadUrlExpirySeconds: 300,
      maxImageBytes: 5 * 1024 * 1024
    });
    // The media storage config stays fully independent: unset here, unaffected by identity storage.
    expect(loadApiConfig({ ...withIdentityStorage, IDENTITY_STORAGE_BUCKET: 'ageniza-identity-local' }).storage).toBeUndefined();
  });

  it('requires the four identity storage settings together in production, keeps its own bucket distinct from media, and rejects a placeholder secret (issue #100)', () => {
    const productionWithoutIdentityStorage = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings
    };
    expect(() => loadApiConfig(productionWithoutIdentityStorage)).toThrow('IDENTITY_STORAGE_ENDPOINT');
    expect(() => loadApiConfig({ ...productionWithoutIdentityStorage, IDENTITY_STORAGE_ENDPOINT: productionIdentityStorageSettings.IDENTITY_STORAGE_ENDPOINT })).toThrow('must be set together');
    expect(loadApiConfig({ ...productionWithoutIdentityStorage, ...productionIdentityStorageSettings }).identityStorage?.bucket).toBe('ageniza-identity');
    expect(() => loadApiConfig({ ...productionWithoutIdentityStorage, ...productionIdentityStorageSettings, IDENTITY_STORAGE_ENDPOINT: 'http://accountid.r2.cloudflarestorage.com' })).toThrow('HTTPS');
    for (const marker of ['placeholder', 'change-me', 'example']) {
      expect(() => loadApiConfig({
        ...productionWithoutIdentityStorage,
        ...productionIdentityStorageSettings,
        IDENTITY_STORAGE_SECRET_ACCESS_KEY: `a1b2c3d4e5f6a1b2c3d4e5f6-${marker}`
      })).toThrow(ConfigValidationError);
    }
    // The identity bucket must never be the same bucket as media: the whole point is separation
    // from a per-agency, quota-limited bucket (issue #100).
    expect(() => loadApiConfig({
      ...productionWithoutIdentityStorage,
      ...productionIdentityStorageSettings,
      IDENTITY_STORAGE_BUCKET: productionStorageSettings.R2_BUCKET
    })).toThrow('must be a different bucket than R2_BUCKET');
    // Nor the same R2 API token: a shared access key would let a compromised credential for one
    // destination reach the other, defeating the separation just as completely as a shared bucket.
    expect(() => loadApiConfig({
      ...productionWithoutIdentityStorage,
      ...productionIdentityStorageSettings,
      IDENTITY_STORAGE_ACCESS_KEY_ID: productionStorageSettings.R2_ACCESS_KEY_ID
    })).toThrow('must be a different access key than R2_ACCESS_KEY_ID');
  });

  it('caps IDENTITY_MAX_IMAGE_BYTES: this upload runs through the API body parser, unlike media\'s presigned PUT (issue #100)', () => {
    expect(loadApiConfig({
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      IDENTITY_STORAGE_ENDPOINT: 'http://localstack:4566',
      IDENTITY_STORAGE_ACCESS_KEY_ID: 'local-access-key',
      IDENTITY_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
      IDENTITY_STORAGE_BUCKET: 'ageniza-identity-local',
      IDENTITY_MAX_IMAGE_BYTES: String(10 * 1024 * 1024)
    }).identityStorage?.maxImageBytes).toBe(10 * 1024 * 1024);
    expect(() => loadApiConfig({
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      IDENTITY_STORAGE_ENDPOINT: 'http://localstack:4566',
      IDENTITY_STORAGE_ACCESS_KEY_ID: 'local-access-key',
      IDENTITY_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
      IDENTITY_STORAGE_BUCKET: 'ageniza-identity-local',
      IDENTITY_MAX_IMAGE_BYTES: String(10 * 1024 * 1024 + 1)
    })).toThrow(ConfigValidationError);
  });

  it('lets the identity storage public endpoint differ from its internal endpoint, mirroring media storage (issue #100)', () => {
    expect(loadApiConfig({
      ...localEnvironment,
      APP_CONTAINER_LOCAL: 'true',
      IDENTITY_STORAGE_ENDPOINT: 'http://localstack:4566',
      IDENTITY_STORAGE_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      IDENTITY_STORAGE_ACCESS_KEY_ID: 'local-access-key',
      IDENTITY_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
      IDENTITY_STORAGE_BUCKET: 'ageniza-identity-local'
    }).identityStorage).toMatchObject({ endpoint: 'http://localstack:4566', publicEndpoint: 'http://127.0.0.1:9000' });
  });

  it('loads the optional public support contact, absent when blank, and refuses one that is not an e-mail', () => {
    expect(loadApiConfig(localEnvironment).supportContactEmail).toBeUndefined();
    expect(loadApiConfig({ ...localEnvironment, SUPPORT_CONTACT_EMAIL: '  ' }).supportContactEmail).toBeUndefined();
    expect(loadApiConfig({ ...localEnvironment, SUPPORT_CONTACT_EMAIL: ' suporte@ageniza.com.br ' }).supportContactEmail).toBe('suporte@ageniza.com.br');
    expect(() => loadApiConfig({ ...localEnvironment, SUPPORT_CONTACT_EMAIL: 'suporte' })).toThrow(ConfigValidationError);
  });

  describe('the public address of the API (issue #737)', () => {
    const production = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    };

    it('is the /api of the public URL by default, where the web container serves the API', () => {
      expect(loadApiConfig(localEnvironment).apiPublicUrl).toBe('http://127.0.0.1:5173/api');
      expect(loadApiConfig(production).apiPublicUrl).toBe('https://app.ageniza.example/api');
      expect(loadApiConfig({ ...production, API_PUBLIC_URL: '  ' }).apiPublicUrl).toBe('https://app.ageniza.example/api');
    });

    it('takes the address given, path included, without a trailing slash', () => {
      expect(loadApiConfig({ ...localEnvironment, API_PUBLIC_URL: 'http://127.0.0.1:3001' }).apiPublicUrl).toBe('http://127.0.0.1:3001');
      expect(loadApiConfig({ ...localEnvironment, API_PUBLIC_URL: 'http://127.0.0.1:3001/' }).apiPublicUrl).toBe('http://127.0.0.1:3001');
      expect(loadApiConfig({ ...production, API_PUBLIC_URL: 'https://app.ageniza.example/api/' }).apiPublicUrl).toBe('https://app.ageniza.example/api');
      expect(loadApiConfig({ ...production, API_PUBLIC_URL: 'https://api.ageniza.example/v1//' }).apiPublicUrl).toBe('https://api.ageniza.example/v1');
    });

    it('refuses an address with credentials, a query or a fragment, without printing it', () => {
      for (const value of ['https://user:pass@app.ageniza.example/api', 'https://app.ageniza.example/api?x=1', 'https://app.ageniza.example/api#x', 'not a url']) {
        expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: value }), value).toThrow(ConfigValidationError);
        expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: value }), value).not.toThrow(/pass|x=1/);
      }
    });

    it('refuses a path that cannot be the Path of a cookie: only letters, digits, ".", "_", "~" and "-" make a segment', () => {
      for (const path of ['/;', '/api;', '/;/x', '/a,b', '/a b', '/a%20b', '/a%3Bb', '/a"b', "/a'b", '/a=b', '/a(b)', '/a@b', '/a:b', '/ä']) {
        const value = 'https://app.ageniza.example' + path;
        expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: value }), value).toThrow(ConfigValidationError);
        expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: value }), value).not.toThrow(/%20|%3B|ä/);
      }
      expect(loadApiConfig({ ...production, API_PUBLIC_URL: 'https://app.ageniza.example/a.b_c~d-e/v2' }).apiPublicUrl).toBe('https://app.ageniza.example/a.b_c~d-e/v2');
    });

    it('requires HTTPS and a non-loopback host in production', () => {
      expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: 'http://app.ageniza.example/api' })).toThrow('must use HTTPS');
      expect(() => loadApiConfig({ ...production, API_PUBLIC_URL: 'https://127.0.0.1/api' })).toThrow('loopback');
    });
  });

  describe('Google sign-in (issue #707)', () => {
    const google = { GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-client-secret-value' };
    const production = {
      ...localEnvironment,
      BETTER_AUTH_SECRET: productionAuthSecret,
      APP_ENV: 'production',
      DATABASE_URL: productionDatabaseUrl,
      APP_PUBLIC_URL: 'https://app.ageniza.example',
      API_CORS_ORIGINS: 'https://app.ageniza.example',
      ...productionEmailSettings,
      ...productionStorageSettings,
      ...productionIdentityStorageSettings
    };

    it('is off without the variables, blank ones included, and the config carries no google key', () => {
      expect(loadApiConfig(localEnvironment)).not.toHaveProperty('google');
      expect(loadApiConfig({ ...localEnvironment, GOOGLE_CLIENT_ID: '  ', GOOGLE_CLIENT_SECRET: '' })).not.toHaveProperty('google');
    });

    it('is on with both, and the callback comes from the public URL under the /api prefix of the web container', () => {
      expect(loadApiConfig({ ...localEnvironment, ...google }).google).toEqual({
        clientId: google.GOOGLE_CLIENT_ID,
        clientSecret: google.GOOGLE_CLIENT_SECRET,
        callbackUrl: 'http://127.0.0.1:5173/api/auth/callback/google'
      });
      expect(loadApiConfig({ ...production, ...google }).google?.callbackUrl).toBe('https://app.ageniza.example/api/auth/callback/google');
    });

    it('takes an explicit callback, for the local stack where the API has its own origin', () => {
      expect(loadApiConfig({ ...localEnvironment, ...google, GOOGLE_CALLBACK_URL: 'http://127.0.0.1:3001/auth/callback/google' }).google?.callbackUrl)
        .toBe('http://127.0.0.1:3001/auth/callback/google');
    });

    it('refuses a half-set pair, and never prints the values it was given', () => {
      const idOnly = () => loadApiConfig({ ...localEnvironment, GOOGLE_CLIENT_ID: google.GOOGLE_CLIENT_ID });
      const secretOnly = () => loadApiConfig({ ...localEnvironment, GOOGLE_CLIENT_SECRET: google.GOOGLE_CLIENT_SECRET });
      expect(idOnly).toThrow(ConfigValidationError);
      expect(secretOnly).toThrow(ConfigValidationError);
      for (const load of [idOnly, secretOnly]) {
        try { load(); } catch (error) {
          expect(String(error)).not.toContain(google.GOOGLE_CLIENT_SECRET);
          expect(String(error)).not.toContain(google.GOOGLE_CLIENT_ID);
        }
      }
    });

    it('requires an HTTPS, non-loopback callback in production', () => {
      expect(() => loadApiConfig({ ...production, ...google, GOOGLE_CALLBACK_URL: 'http://app.ageniza.example/api/auth/callback/google' })).toThrow('must use HTTPS');
      expect(() => loadApiConfig({ ...production, ...google, GOOGLE_CALLBACK_URL: 'https://127.0.0.1/api/auth/callback/google' })).toThrow('loopback');
    });
  });
});
