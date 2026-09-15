import { describe, expect, it } from 'vitest';

import { assertLocalDatabaseUrl, createDatabaseClient, createVerifiedUserClaims } from '../src/index.js';

describe('@ageniza/database local safety and lifecycle', () => {
  it('allows only loopback PostgreSQL URLs in local/test helpers', () => {
    expect(() => assertLocalDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgresql://postgres:postgres@localhost:54322/postgres')).not.toThrow();
    expect(() => assertLocalDatabaseUrl('postgresql://postgres:postgres@db.example.com:5432/postgres')).toThrow('loopback');
  });

  it('uses a conservative pool and closes idempotently without opening a connection', async () => {
    const database = createDatabaseClient({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
    expect(database.pool).toEqual({ min: 0, max: 4, idleTimeoutMillis: 10_000, acquireTimeoutMillis: 5_000 });
    await database.close();
    await database.close();
    expect(() => database.transaction(async () => 'unreachable')).toThrow('already been closed');
  });

  it('rejects pool sizes and timeouts that would disable bounded connection behavior', () => {
    const connectionString = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    expect(() => createDatabaseClient({ connectionString, pool: { min: -1 } })).toThrow('non-negative');
    expect(() => createDatabaseClient({ connectionString, pool: { max: 0 } })).toThrow('positive');
    expect(() => createDatabaseClient({ connectionString, pool: { idleTimeoutMillis: 0 } })).toThrow('positive');
    expect(() => createDatabaseClient({ connectionString, pool: { acquireTimeoutMillis: 0 } })).toThrow('positive');
    expect(() => createDatabaseClient({ connectionString, pool: { min: 3, max: 2 } })).toThrow('no smaller');
  });

  it('requires a UUID and creates a narrow verified-user capability', () => {
    expect(() => createVerifiedUserClaims({ userId: 'not-a-uuid' })).toThrow('UUID');
    expect(createVerifiedUserClaims({ userId: '00000000-0000-4000-8000-000000000001' }).userId).toBe(
      '00000000-0000-4000-8000-000000000001'
    );
  });
});
