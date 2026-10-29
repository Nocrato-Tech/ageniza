import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cloneIntegrationDatabase,
  createIntegrationModel,
  dropIntegrationDatabases,
  resolveIntegrationDatabaseUrls,
  withDatabaseName,
  type IntegrationClone,
  type IntegrationModel
} from '../src/index.js';

const urls = resolveIntegrationDatabaseUrls();
let model: IntegrationModel;
let modelDropped = false;
const clones: IntegrationClone[] = [];

const query = async <TRow extends object>(connectionString: string, sql: string, params: readonly unknown[] = []): Promise<TRow[]> => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return (await client.query<TRow>(sql, Array.from(params))).rows;
  } finally {
    await client.end();
  }
};

const databaseExists = async (name: string): Promise<boolean> =>
  (await query(urls.ownerUrl, 'select 1 from pg_catalog.pg_database where datname = $1', [name])).length === 1;

const newClone = async (): Promise<IntegrationClone> => {
  const clone = await cloneIntegrationDatabase(model);
  clones.push(clone);
  return clone;
};

beforeAll(async () => {
  model = await createIntegrationModel(urls);
}, 60_000);

afterAll(async () => {
  if (!modelDropped) await dropIntegrationDatabases(model);
});

describe('the model and clone databases of the integration suites (issue #792)', () => {
  it('migrates the model like the database the operator pointed at, and leaves that one alone', async () => {
    const tables = `select table_schema, table_name from information_schema.tables where table_schema in ('public', 'auth', 'app_private', 'audit') order by 1, 2`;
    const baseTables = await query(urls.ownerUrl, tables);
    const clone = await newClone();

    expect(baseTables.length).toBeGreaterThan(20);
    expect(await query(clone.ownerUrl, tables)).toEqual(baseTables);
    expect(await query(clone.ownerUrl, 'select name from public.knex_migrations order by id')).toEqual(
      await query(urls.ownerUrl, 'select name from public.knex_migrations order by id')
    );
  });

  it('gives each clone rows of its own: a row written in one is invisible in the other and in the model', async () => {
    const first = await newClone();
    const second = await newClone();
    const agencyId = randomUUID();
    await query(first.ownerUrl, `insert into public.agencies (id, name, owner_user_id, status) values ($1, 'Isolated', null, 'active')`, [agencyId]);

    expect(await query(first.ownerUrl, 'select id from public.agencies where id = $1', [agencyId])).toHaveLength(1);
    expect(await query(second.ownerUrl, 'select id from public.agencies where id = $1', [agencyId])).toHaveLength(0);
    expect(await query(withDatabaseName(urls.ownerUrl, model.modelDatabase), 'select id from public.agencies where id = $1', [agencyId])).toHaveLength(0);
  });

  it('carries the grants and the search_path the application role needs: the same as the migrated database', async () => {
    const clone = await newClone();
    const grants = `select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'ageniza_app' order by 1, 2, 3, 4`;
    const settings = `select current_database() is not null as connected, current_setting('search_path') as search_path, current_user as role,
      (select rolbypassrls or rolsuper from pg_catalog.pg_roles where rolname = current_user) as bypasses`;

    const inClone = await query(clone.applicationUrl, settings);
    expect(inClone).toEqual(await query(urls.applicationUrl, settings));
    expect(inClone[0]).toMatchObject({ role: 'ageniza_app', bypasses: false });
    const cloneGrants = await query(clone.ownerUrl, grants);
    expect(cloneGrants.length).toBeGreaterThan(10);
    expect(cloneGrants).toEqual(await query(urls.ownerUrl, grants));
    // RLS answers as the application role does anywhere else: no actor, no tenant rows.
    expect(await query(clone.applicationUrl, 'select id from public.agencies')).toEqual([]);
  });

  it('drops a clone the test file left connected, and drops it twice without complaint', async () => {
    const clone = await newClone();
    const stuck = new Client({ connectionString: clone.applicationUrl });
    await stuck.connect();
    stuck.on('error', () => undefined);

    await clone.drop();
    await clone.drop();

    expect(await databaseExists(clone.database)).toBe(false);
    await stuck.end().catch(() => undefined);
  });

  it('drops the clones a crashed worker left behind, then the model, and nothing of another run', async () => {
    const left = await newClone();
    const otherRun = await createIntegrationModel(urls);
    const strayOfOtherRun = await cloneIntegrationDatabase(otherRun);
    try {
      await dropIntegrationDatabases(model);
      modelDropped = true;

      expect(await databaseExists(left.database)).toBe(false);
      expect(await databaseExists(model.modelDatabase)).toBe(false);
      expect(await databaseExists(strayOfOtherRun.database)).toBe(true);
      expect(await databaseExists(otherRun.modelDatabase)).toBe(true);
    } finally {
      await dropIntegrationDatabases(otherRun);
    }
    expect(await databaseExists(strayOfOtherRun.database)).toBe(false);
  }, 60_000);
});
