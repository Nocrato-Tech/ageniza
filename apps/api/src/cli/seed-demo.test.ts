import { describe, expect, it } from 'vitest';

import { assertSeedAllowed, demoId, resolveSeedEnvironment, runSeedDemo, SEED_FLAG, SeedDemoError } from './seed-demo.js';

const localEnvironment = {
  DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
  MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza'
};

const allow = (env: Record<string, string | undefined>, argv: readonly string[] = [SEED_FLAG]): void => {
  assertSeedAllowed({
    argv,
    env,
    databaseUrl: env.DATABASE_URL!,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL!
  });
};

describe('seed:demo gate (issue #183)', () => {
  it('accepts a loopback database with the explicit flag', () => {
    expect(() => allow(localEnvironment)).not.toThrow();
    expect(() => allow({ ...localEnvironment, APP_ENV: 'local' })).not.toThrow();
    expect(() => allow({ ...localEnvironment, DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@localhost:54322/ageniza' })).not.toThrow();
  });

  it('refuses without --i-know-this-is-local', () => {
    expect(() => allow(localEnvironment, [])).toThrow(/--i-know-this-is-local/);
  });

  it('refuses production regardless of case or surrounding whitespace', () => {
    expect(() => allow({ ...localEnvironment, NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => allow({ ...localEnvironment, NODE_ENV: 'Production' })).toThrow(/production/);
    expect(() => allow({ ...localEnvironment, NODE_ENV: ' production ' })).toThrow(/production/);
    expect(() => allow({ ...localEnvironment, APP_ENV: 'PRODUCTION' })).toThrow(/production/);
    expect(() => allow({ ...localEnvironment, NODE_ENV: 'development' })).not.toThrow();
  });

  it('refuses a remote application database', () => {
    expect(() => allow({ ...localEnvironment, DATABASE_URL: 'postgresql://ageniza_app:secret@db.example.com:5432/ageniza' }))
      .toThrow(/loopback/);
  });

  it('refuses a remote migration database', () => {
    expect(() => allow({ ...localEnvironment, MIGRATION_DATABASE_URL: 'postgresql://postgres:secret@10.0.0.7:5432/ageniza' }))
      .toThrow(/loopback/);
  });

  it('refuses the host-override query parameter in either connection', () => {
    expect(() => allow({ ...localEnvironment, DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza?host=nao-local.invalid' }))
      .toThrow(/loopback/);
    expect(() => allow({ ...localEnvironment, MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza?hostaddr=203.0.113.9' }))
      .toThrow(/loopback/);
  });

  it('refuses when the two connections point at different databases', () => {
    expect(() => allow({
      DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_a',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza_b'
    })).toThrow(/same host, port and database/);
  });

  it('refuses a port override in the query string, which the driver honours', () => {
    expect(() => allow({
      DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza?port=5433'
    })).toThrow(/same host, port and database/);
  });

  it('refuses when only one URL is defined and the default points elsewhere', () => {
    // The gate receives resolved URLs; the default MIGRATION_DATABASE_URL points at `ageniza`, so
    // exporting only a different DATABASE_URL must fail instead of writing to two databases.
    const env = { DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_ds' };
    const resolved = resolveSeedEnvironment(env);
    expect(() => assertSeedAllowed({
      argv: [SEED_FLAG],
      env,
      databaseUrl: resolved.databaseUrl,
      migrationDatabaseUrl: resolved.migrationDatabaseUrl
    })).toThrow(/same host, port and database/);
  });

  it('refuses unknown arguments, so a typo cannot silently skip the intent', () => {
    expect(() => allow(localEnvironment, [SEED_FLAG, '--force'])).toThrow(/Unknown argument/);
  });
});

describe('seed:demo command refuses before connecting (issue #183 review)', () => {
  // If `runSeedDemo` ever stops calling the gate, the injected factory runs and the rejection is
  // this error instead of a `SeedDemoError`, which is what makes the mutation visible.
  const neverConnect = () => {
    throw new Error('the command must not open a connection');
  };

  it('refuses a remote database before opening any connection', async () => {
    await expect(runSeedDemo({
      env: { ...localEnvironment, DATABASE_URL: 'postgresql://ageniza_app:secret@db.example.com:5432/ageniza' },
      argv: [SEED_FLAG],
      connect: neverConnect
    })).rejects.toBeInstanceOf(SeedDemoError);
  });

  it('refuses NODE_ENV=production before opening any connection', async () => {
    await expect(runSeedDemo({
      env: { ...localEnvironment, NODE_ENV: 'Production' },
      argv: [SEED_FLAG],
      connect: neverConnect
    })).rejects.toBeInstanceOf(SeedDemoError);
  });

  it('refuses divergent databases before rotating any password', async () => {
    await expect(runSeedDemo({
      env: {
        DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_a',
        MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza_b'
      },
      argv: [SEED_FLAG],
      connect: neverConnect
    })).rejects.toThrow(/same host, port and database/);
  });

  it('refuses without the flag before opening any connection', async () => {
    await expect(runSeedDemo({ env: localEnvironment, argv: [], connect: neverConnect })).rejects.toThrow(/--i-know-this-is-local/);
  });
});

describe('seed:demo identifiers', () => {
  it('derives the same valid UUID for the same demo key', () => {
    const first = demoId('user:marina');
    expect(first).toBe(demoId('user:marina'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(demoId('user:rafael')).not.toBe(first);
  });

  it('defaults to the documented local stack, versions and public URL', () => {
    expect(resolveSeedEnvironment({})).toEqual({
      databaseUrl: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
      migrationDatabaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza',
      appPublicUrl: 'http://127.0.0.1:5173',
      termsVersion: '2026-01-01',
      privacyVersion: '2026-02-01'
    });
    expect(resolveSeedEnvironment({ APP_PUBLIC_URL: 'http://127.0.0.1:5173/' }).appPublicUrl).toBe('http://127.0.0.1:5173');
    expect(resolveSeedEnvironment({ AUTH_TERMS_VERSION: '2027-03-01', AUTH_PRIVACY_VERSION: '2027-04-01' }))
      .toMatchObject({ termsVersion: '2027-03-01', privacyVersion: '2027-04-01' });
  });
});
