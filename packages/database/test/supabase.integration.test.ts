import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let database: DatabaseClient | undefined;

beforeAll(async () => {
  database = createLocalTestDatabaseClient(connectionString);
  await database.knex.raw(`
    drop schema if exists test_support cascade;
    create schema test_support;
    revoke all on schema test_support from public;
    grant usage on schema test_support to authenticated;
    create table test_support.rls_isolation_probe (
      id uuid primary key,
      owner_user_id uuid not null,
      secret text not null
    );
    alter table test_support.rls_isolation_probe enable row level security;
    alter table test_support.rls_isolation_probe force row level security;
    grant select, insert on test_support.rls_isolation_probe to authenticated;
    create policy rls_isolation_probe_authenticated_users_only
      on test_support.rls_isolation_probe for select to authenticated
      using ((select auth.uid()) = owner_user_id);
    create policy rls_isolation_probe_authenticated_users_insert_own
      on test_support.rls_isolation_probe for insert to authenticated
      with check ((select auth.uid()) = owner_user_id);
  `);
});

afterAll(async () => {
  if (database !== undefined) {
    try {
      await database.knex.raw('drop schema if exists test_support cascade');
    } finally {
      await database.close();
    }
  }
});

const getDatabase = (): DatabaseClient => {
  if (database === undefined) throw new Error('Integration database was not initialized.');
  return database;
};

describe('local Supabase database foundation', () => {
  it('uses a pooled Knex connection, transactions, and pg parameter bindings', async () => {
    const database = getDatabase();
    const probe = `literal-'-${randomUUID()}`;
    const result = await raw<{ rows: Array<{ value: string }> }>(database.knex, 'select ?::text as value', [probe]);
    expect(result.rows[0]?.value).toBe(probe);

    const id = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction('test_support.rls_isolation_probe').insert({ id, owner_user_id: randomUUID(), secret: 'transaction-committed' });
    });
    const committed = await database.knex('test_support.rls_isolation_probe').where({ id }).first('secret');
    expect(committed).toEqual({ secret: 'transaction-committed' });

    const rolledBackId = randomUUID();
    await expect(database.transaction(async (transaction) => {
      await transaction('test_support.rls_isolation_probe').insert({ id: rolledBackId, owner_user_id: randomUUID(), secret: 'rolled-back' });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    await expect(database.knex('test_support.rls_isolation_probe').where({ id: rolledBackId }).first()).resolves.toBeUndefined();
  });

  it('keeps tenant A unable to read tenant B through RLS', async () => {
    const database = getDatabase();
    const tenantAUserId = randomUUID();
    const tenantBUserId = randomUUID();
    const tenantARowId = randomUUID();
    const tenantBRowId = randomUUID();

    await database.knex('test_support.rls_isolation_probe').insert([
      { id: tenantARowId, owner_user_id: tenantAUserId, secret: 'tenant-a-only' },
      { id: tenantBRowId, owner_user_id: tenantBUserId, secret: 'tenant-b-only' }
    ]);

    const tenantARows = await withAuthenticatedUserTransaction(
      database,
      createVerifiedUserClaims({ userId: tenantAUserId }),
      (transaction) => transaction('test_support.rls_isolation_probe').select('id', 'secret').orderBy('id')
    );
    expect(tenantARows).toEqual([{ id: tenantARowId, secret: 'tenant-a-only' }]);
  });
});
