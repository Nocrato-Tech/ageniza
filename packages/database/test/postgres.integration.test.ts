import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Run `pnpm db:migrate` on your own database first; the owner client only builds fixtures.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const recordA = randomUUID();
const recordB = randomUUID();

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  // Tenant access is derived from memberships inside policies, never from a client-supplied agency id.
  await owner.knex.raw(`
    drop schema if exists test_support cascade;
    create schema test_support;
    grant usage on schema test_support to ageniza_app;

    create table test_support.agency_memberships (
      user_id uuid not null,
      agency_id uuid not null,
      primary key (user_id, agency_id)
    );
    alter table test_support.agency_memberships enable row level security;
    alter table test_support.agency_memberships force row level security;
    grant select on test_support.agency_memberships to ageniza_app;
    create policy memberships_own on test_support.agency_memberships for select to ageniza_app
      using (user_id = app_private.current_user_id());

    create table test_support.agency_records (
      id uuid primary key,
      agency_id uuid not null,
      secret text not null
    );
    alter table test_support.agency_records enable row level security;
    alter table test_support.agency_records force row level security;
    grant select, insert, update, delete on test_support.agency_records to ageniza_app;
    create policy agency_records_member_access on test_support.agency_records for all to ageniza_app
      using (exists (
        select 1 from test_support.agency_memberships membership
        where membership.agency_id = agency_records.agency_id and membership.user_id = app_private.current_user_id()
      ))
      with check (exists (
        select 1 from test_support.agency_memberships membership
        where membership.agency_id = agency_records.agency_id and membership.user_id = app_private.current_user_id()
      ));
  `);
  await owner.knex('test_support.agency_memberships').insert([
    { user_id: userA, agency_id: agencyA },
    { user_id: userB, agency_id: agencyB }
  ]);
  await owner.knex('test_support.agency_records').insert([
    { id: recordA, agency_id: agencyA, secret: 'agency-a-only' },
    { id: recordB, agency_id: agencyB, secret: 'agency-b-only' }
  ]);
});

afterAll(async () => {
  try {
    await owner?.knex.raw('drop schema if exists test_support cascade');
  } finally {
    await application?.close();
    await owner?.close();
  }
});

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUserA = <TResult>(work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: userA }), work);

const secretOf = async (id: string): Promise<string | undefined> =>
  (await getOwner().knex('test_support.agency_records').where({ id }).first('secret'))?.secret;

describe('local PostgreSQL database foundation', () => {
  it('uses pooled Knex connections, transactions, and pg parameter bindings', async () => {
    const database = getOwner();
    const probe = `literal-'-${randomUUID()}`;
    const result = await raw<{ rows: Array<{ value: string }> }>(database.knex, 'select ?::text as value', [probe]);
    expect(result.rows[0]?.value).toBe(probe);

    const rolledBackId = randomUUID();
    await expect(database.transaction(async (transaction) => {
      await transaction('test_support.agency_records').insert({ id: rolledBackId, agency_id: agencyA, secret: 'rolled-back' });
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    await expect(secretOf(rolledBackId)).resolves.toBeUndefined();
  });

  it('connects the application as a role that cannot bypass RLS', async () => {
    const result = await raw<{ rows: Array<{ rolsuper: boolean; rolbypassrls: boolean }> }>(
      getApplication().knex,
      'select rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = current_user',
      []
    );
    expect(result.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('shows the application role nothing without a verified user context', async () => {
    const rows = await getApplication().transaction((transaction) => transaction('test_support.agency_records').select('id'));
    expect(rows).toEqual([]);
  });

  it('keeps agency A unable to SELECT, INSERT, UPDATE, or DELETE agency B data', async () => {
    await expect(asUserA((transaction) => transaction('test_support.agency_records').select('id', 'secret'))).resolves.toEqual([
      { id: recordA, secret: 'agency-a-only' }
    ]);

    await expect(asUserA((transaction) =>
      transaction('test_support.agency_records').insert({ id: randomUUID(), agency_id: agencyB, secret: 'planted-by-a' })
    )).rejects.toThrow(/row-level security/);

    await expect(asUserA((transaction) =>
      transaction('test_support.agency_records').where({ id: recordB }).update({ secret: 'changed-by-a' })
    )).resolves.toBe(0);
    await expect(secretOf(recordB)).resolves.toBe('agency-b-only');

    await expect(asUserA((transaction) =>
      transaction('test_support.agency_records').where({ id: recordA }).update({ agency_id: agencyB })
    )).rejects.toThrow(/row-level security/);

    await expect(asUserA((transaction) => transaction('test_support.agency_records').where({ id: recordB }).delete())).resolves.toBe(0);
    await expect(secretOf(recordB)).resolves.toBe('agency-b-only');
  });

  it('lets agency A manage its own data under the same policies', async () => {
    const ownRecord = randomUUID();
    await asUserA(async (transaction) => {
      await transaction('test_support.agency_records').insert({ id: ownRecord, agency_id: agencyA, secret: 'created-by-a' });
      await expect(transaction('test_support.agency_records').where({ id: ownRecord }).update({ secret: 'updated-by-a' })).resolves.toBe(1);
    });
    await expect(secretOf(ownRecord)).resolves.toBe('updated-by-a');
    await expect(asUserA((transaction) => transaction('test_support.agency_records').where({ id: ownRecord }).delete())).resolves.toBe(1);
    await expect(secretOf(ownRecord)).resolves.toBeUndefined();
  });
});
