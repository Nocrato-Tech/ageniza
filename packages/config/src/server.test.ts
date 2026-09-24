import { describe, expect, it } from 'vitest';

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

describe('server configuration', () => {
  it('loads typed local API and worker configuration', () => {
    expect(loadApiConfig(localEnvironment)).toMatchObject({
      service: 'api', environment: 'local', authSecret: localEnvironment.BETTER_AUTH_SECRET, appPublicUrl: localEnvironment.APP_PUBLIC_URL,
      authTermsVersion: '2026-01-01', authPrivacyVersion: '2026-02-01',
      host: '0.0.0.0', port: 3001, corsOrigins: ['http://127.0.0.1:5173'], bodyLimitBytes: 1_048_576, trustedProxyCidrs: []
    });
    expect(loadWorkerConfig(localEnvironment)).toEqual({
      service: 'worker',
      environment: 'local',
      databaseUrl: localEnvironment.DATABASE_URL,
      healthHost: '127.0.0.1',
      healthPort: 3002,
      smokeJob: false,
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
      ...productionStorageSettings
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
    expect(loadApiConfig({ ...localEnvironment, AUTH_TERMS_VERSION: '2027-12-31', AUTH_PRIVACY_VERSION: '2028-01-01' })).toMatchObject({
      authTermsVersion: '2027-12-31', authPrivacyVersion: '2028-01-01'
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
      ...productionStorageSettings
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
      ...productionStorageSettings
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
      ...productionStorageSettings
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
    expect(loadApiConfig({ ...productionWithoutEmail, ...productionEmailSettings, ...productionStorageSettings }).smtpUrl).toBe(productionEmailSettings.SMTP_URL);
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
      ...productionStorageSettings
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
    expect(loadApiConfig({ ...productionWithoutStorage, ...productionStorageSettings }).storage?.bucket).toBe('ageniza-media');
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
      DATABASE_URL: productionDatabaseUrl
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
});
