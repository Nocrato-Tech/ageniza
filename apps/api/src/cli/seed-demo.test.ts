import { describe, expect, it } from 'vitest';

import { assertSeedAllowed, demoId, resolveSeedEnvironment, SEED_FLAG } from './seed-demo.js';

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

  it('refuses NODE_ENV=production', () => {
    expect(() => allow({ ...localEnvironment, NODE_ENV: 'production' })).toThrow(/production/);
  });

  it('refuses APP_ENV=production', () => {
    expect(() => allow({ ...localEnvironment, APP_ENV: 'production' })).toThrow(/production/);
  });

  it('refuses a remote application database', () => {
    expect(() => allow({ ...localEnvironment, DATABASE_URL: 'postgresql://ageniza_app:secret@db.example.com:5432/ageniza' }))
      .toThrow(/loopback/);
  });

  it('refuses a remote migration database', () => {
    expect(() => allow({ ...localEnvironment, MIGRATION_DATABASE_URL: 'postgresql://postgres:secret@10.0.0.7:5432/ageniza' }))
      .toThrow(/loopback/);
  });

  it('refuses unknown arguments, so a typo cannot silently skip the intent', () => {
    expect(() => allow(localEnvironment, [SEED_FLAG, '--force'])).toThrow(/Unknown argument/);
  });
});

describe('seed:demo identifiers', () => {
  it('derives the same valid UUID for the same demo key', () => {
    const first = demoId('user:marina');
    expect(first).toBe(demoId('user:marina'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(demoId('user:rafael')).not.toBe(first);
  });

  it('defaults to the documented local stack and strips a trailing slash from the public URL', () => {
    expect(resolveSeedEnvironment({})).toEqual({
      databaseUrl: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza',
      migrationDatabaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza',
      appPublicUrl: 'http://127.0.0.1:5173'
    });
    expect(resolveSeedEnvironment({ APP_PUBLIC_URL: 'http://127.0.0.1:5173/' }).appPublicUrl).toBe('http://127.0.0.1:5173');
  });
});
