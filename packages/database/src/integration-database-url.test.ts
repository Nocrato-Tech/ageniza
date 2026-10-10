import { afterEach, describe, expect, it } from 'vitest';

import { integrationDatabaseEnvironment, resolveIntegrationDatabaseUrls } from './index.js';

const own = {
  DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza_agent391',
  MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza_agent391'
};

const originalPGDATABASE = process.env.PGDATABASE;

afterEach(() => {
  if (originalPGDATABASE === undefined) delete process.env.PGDATABASE;
  else process.env.PGDATABASE = originalPGDATABASE;
});

describe('resolveIntegrationDatabaseUrls (issue #391)', () => {
  it('returns both URLs untouched when they name a database of its own', () => {
    expect(resolveIntegrationDatabaseUrls(own)).toEqual({ applicationUrl: own.DATABASE_URL, ownerUrl: own.MIGRATION_DATABASE_URL });
  });

  it('accepts databases that merely start with the protected name', () => {
    for (const name of ['ageniza_ci', 'ageniza_app', 'ageniza2', 'Ageniza']) {
      const urls = {
        DATABASE_URL: `postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/${name}`,
        MIGRATION_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:54322/${name}`
      };
      expect(() => resolveIntegrationDatabaseUrls(urls), name).not.toThrow();
    }
  });

  it('has no default: with neither variable it refuses and names both', () => {
    expect(() => resolveIntegrationDatabaseUrls({})).toThrow(/DATABASE_URL and MIGRATION_DATABASE_URL/);
  });

  it('refuses each missing variable on its own, naming only that one', () => {
    expect(() => resolveIntegrationDatabaseUrls({ DATABASE_URL: own.DATABASE_URL })).toThrow(/need MIGRATION_DATABASE_URL pointing/);
    expect(() => resolveIntegrationDatabaseUrls({ MIGRATION_DATABASE_URL: own.MIGRATION_DATABASE_URL })).toThrow(/need DATABASE_URL pointing/);
  });

  it('treats an empty or blank variable as missing', () => {
    expect(() => resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: '' })).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() => resolveIntegrationDatabaseUrls({ ...own, DATABASE_URL: '   ' })).toThrow(/need DATABASE_URL/);
  });

  it('refuses the database named ageniza on either variable, before anything connects', () => {
    expect(() =>
      resolveIntegrationDatabaseUrls({ ...own, DATABASE_URL: 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza' })
    ).toThrow(/DATABASE_URL points at the database `ageniza`/);
    expect(() =>
      resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza' })
    ).toThrow(/MIGRATION_DATABASE_URL points at the database `ageniza`/);
  });

  it('compares the name the driver would connect to, not the URL path', () => {
    // A percent-encoded name and a missing path (the driver falls back to PGDATABASE, then to the user
    // name) all reach `ageniza` without the path saying so (lesson from #188).
    for (const url of ['postgresql://postgres:postgres@127.0.0.1:54322/%61geniza', 'postgresql://ageniza@127.0.0.1:54322']) {
      expect(() => resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: url }), url).toThrow(/`ageniza`/);
    }
    process.env.PGDATABASE = 'ageniza';
    expect(() => resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322' })).toThrow(/`ageniza`/);
  });

  it('still refuses a database that is not on loopback', () => {
    expect(() =>
      resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@db.example.com:5432/ageniza_agent391' })
    ).toThrow(/loopback/);
  });

  it('never repeats a credential in a refusal', () => {
    let message = '';
    try {
      resolveIntegrationDatabaseUrls({ ...own, MIGRATION_DATABASE_URL: 'postgresql://postgres:s3cret-pass@127.0.0.1:54322/ageniza' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('s3cret-pass');
  });
});

describe('integrationDatabaseEnvironment (issue #434)', () => {
  it('hands an operation the two variables the resolver accepted, under their own names', () => {
    expect(integrationDatabaseEnvironment(own)).toEqual({ DATABASE_URL: own.DATABASE_URL, MIGRATION_DATABASE_URL: own.MIGRATION_DATABASE_URL });
  });

  it('keeps the refusals of the resolver: no default, and never the protected database', () => {
    expect(() => integrationDatabaseEnvironment({})).toThrow(/DATABASE_URL and MIGRATION_DATABASE_URL/);
    expect(() => integrationDatabaseEnvironment({ ...own, MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza' })).toThrow(/MIGRATION_DATABASE_URL points at the database `ageniza`/);
  });
});
