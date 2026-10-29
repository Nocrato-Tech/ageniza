import { describe, expect, it } from 'vitest';

import { integrationCloneName, integrationModelName, withDatabaseName } from './index.js';

describe('withDatabaseName (issue #792)', () => {
  it('swaps only the database and keeps credentials, server and options', () => {
    expect(withDatabaseName('postgresql://ageniza_app:secret@127.0.0.1:54322/ageniza_base?sslmode=disable', 'ageniza_base_ca1b2c3_00ff00ff'))
      .toBe('postgresql://ageniza_app:secret@127.0.0.1:54322/ageniza_base_ca1b2c3_00ff00ff?sslmode=disable');
  });

  it('refuses a name that is not a plain identifier, so nothing reaches the SQL text', () => {
    for (const name of ['', 'a b', 'x"; drop database ageniza; --', 'a/b', 'x'.repeat(64)]) {
      expect(() => withDatabaseName('postgresql://postgres:postgres@127.0.0.1:54322/ageniza_base', name), name).toThrow(/database name/);
    }
  });
});

describe('integration database names (issue #792)', () => {
  it('derive from the operator\'s database and never equal it, so the protected name cannot be produced', () => {
    expect(integrationModelName('ageniza_ci', 'a1b2c3')).toBe('ageniza_ci_ma1b2c3');
    expect(integrationCloneName('ageniza_ci', 'a1b2c3', '00ff00ff')).toBe('ageniza_ci_ca1b2c3_00ff00ff');
    expect(integrationModelName('ageniza', 'a1b2c3')).not.toBe('ageniza');
    expect(integrationCloneName('ageniza', 'a1b2c3', '00ff00ff')).not.toBe('ageniza');
  });

  it('keeps a clone of a different run out of the prefix a teardown drops', () => {
    const mine = integrationCloneName('ageniza_ci', 'a1b2c3', 'x');
    const other = integrationCloneName('ageniza_ci', 'd4e5f6', 'x');
    expect(mine.startsWith('ageniza_ci_ca1b2c3_')).toBe(true);
    expect(other.startsWith('ageniza_ci_ca1b2c3_')).toBe(false);
  });

  it('refuses a name past the 63 bytes PostgreSQL keeps', () => {
    expect(() => integrationCloneName('b'.repeat(50), 'a1b2c3', '00ff00ff')).toThrow(/database name/);
  });
});
