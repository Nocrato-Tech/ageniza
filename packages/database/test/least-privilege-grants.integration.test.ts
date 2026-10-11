import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, type DatabaseClient, resolveIntegrationDatabaseUrls } from '../src/index.js';

// Issue #372. The application role gets, per table, only what a route or the worker does with it: INSERT and UPDATE by
// column, no DELETE on a business entity, and no table of `public` or `auth` is open to it by default. The catalog test
// below reads the live grants, so a table or a grant added later that opens a whole table turns it red; the probe tests
// prove that detector sees such a grant before trusting its silence.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await application?.close();
  await owner?.close();
});

// The one table of `public` where the application role may DELETE: the preference of the person's own context, with a
// delete policy of its own, and not a business entity. Anything else with a DELETE is an entity that is archived or
// removed, never deleted (docs/business/structural-changes.md, "Exclusão reversível").
const DELETABLE = ['user_context_preferences'];

type Executor = Knex | Knex.Transaction;

const wholeTableGrants = async (executor: Executor): Promise<string[]> => {
  const { rows } = await raw<{ rows: readonly { grant: string }[] }>(executor, `
    select c.relname || ' ' || privilege as grant
    from pg_catalog.pg_class c
    cross join unnest(array['insert', 'update', 'delete', 'truncate']) as privilege
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      and pg_catalog.has_table_privilege('ageniza_app', c.oid, privilege)
      and not (privilege = 'delete' and c.relname = any(array[${DELETABLE.map((name) => `'${name}'`).join(', ')}]))
    order by 1
  `, []);
  return rows.map((row) => row.grant);
};

// Only the probe table, so the detector is judged on what it sees and not on the rest of the catalog.
const probeGrants = async (executor: Executor): Promise<string[]> => (await wholeTableGrants(executor)).filter((grant) => grant.startsWith('zz_least_privilege_probe '));

const columnsWith = async (table: string, privilege: 'insert' | 'update'): Promise<string[]> => {
  const { rows } = await raw<{ rows: readonly { name: string }[] }>(getOwner().knex, `
    select attribute.attname as name
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = ?::regclass and attribute.attnum > 0 and not attribute.attisdropped
      and pg_catalog.has_column_privilege('ageniza_app', attribute.attrelid, attribute.attnum, ?)
    order by 1
  `, [table, privilege]);
  return rows.map((row) => row.name);
};

const asApplication = async (statement: string, bindings: readonly unknown[] = []): Promise<unknown> => {
  const transaction = await getApplication().knex.transaction();
  try {
    await transaction.raw(statement, [...bindings]);
    return 'ok';
  } catch (error) {
    return error;
  } finally {
    await transaction.rollback();
  }
};

const probe = async (work: (transaction: Executor) => Promise<void>): Promise<void> => {
  const transaction = await getOwner().knex.transaction();
  try {
    await work(transaction);
  } finally {
    await transaction.rollback();
  }
};

describe('no table of public is open to the application role as a whole (acceptance 3)', () => {
  it('gives no INSERT, UPDATE or TRUNCATE of a whole table, and DELETE only where it is the person\'s own preference', async () => {
    expect(await wholeTableGrants(getOwner().knex)).toEqual([]);
  });

  it('keeps the one DELETE: the preference of the person, with its own delete policy', async () => {
    const { rows } = await raw<{ rows: readonly { can_delete: boolean; policies: string[] }[] }>(getOwner().knex, `
      select pg_catalog.has_table_privilege('ageniza_app', 'public.user_context_preferences', 'delete') as can_delete,
             array(select polcmd::text from pg_catalog.pg_policy where polrelid = 'public.user_context_preferences'::regclass and polcmd = 'd') as policies
    `, []);
    expect(rows[0]).toEqual({ can_delete: true, policies: ['d'] });
  });

  it('sees a broad grant: a new table granted whole to the application role is reported, for each privilege', async () => {
    await probe(async (transaction) => {
      await transaction.raw('create table public.zz_least_privilege_probe (id integer)');
      expect(await probeGrants(transaction)).toEqual([]);

      await transaction.raw('grant insert on public.zz_least_privilege_probe to ageniza_app');
      expect(await probeGrants(transaction)).toEqual(['zz_least_privilege_probe insert']);
      await transaction.raw('grant update, delete on public.zz_least_privilege_probe to ageniza_app');
      expect(await probeGrants(transaction)).toEqual(['zz_least_privilege_probe delete', 'zz_least_privilege_probe insert', 'zz_least_privilege_probe update']);
    });
  });

  it('does not report a grant by column, which is the shape a table is supposed to have', async () => {
    await probe(async (transaction) => {
      await transaction.raw('create table public.zz_least_privilege_probe (id integer, name text)');
      await transaction.raw('grant select on public.zz_least_privilege_probe to ageniza_app');
      await transaction.raw('grant insert (name), update (name) on public.zz_least_privilege_probe to ageniza_app');
      expect(await probeGrants(transaction)).toEqual([]);
    });
  });
});

describe('a new table has no automatic privilege for the application role (acceptance 2)', () => {
  it('has no default privilege on tables for it in public, in auth, or in every schema', async () => {
    const { rows } = await raw<{ rows: readonly { owner: string; schema: string | null; privilege: string }[] }>(getOwner().knex, `
      select pg_catalog.pg_get_userbyid(d.defaclrole)::text as owner, d.defaclnamespace::regnamespace::text as schema, acl.privilege_type as privilege
      from pg_catalog.pg_default_acl d
      cross join lateral pg_catalog.aclexplode(d.defaclacl) acl
      where d.defaclobjtype = 'r'
        and acl.grantee = 'ageniza_app'::regrole
        and (d.defaclnamespace = 0 or d.defaclnamespace in ('public'::regnamespace, 'auth'::regnamespace))
      order by 1, 2, 3
    `, []);
    expect(rows).toEqual([]);
  });

  it.each(['public', 'auth'])('leaves a table created in %s without any privilege for the application role until a migration grants it', async (schema) => {
    await probe(async (transaction) => {
      await transaction.raw(`create table ${schema}.zz_least_privilege_probe (id integer)`);
      const { rows } = await raw<{ rows: readonly { privilege: string; granted: boolean }[] }>(transaction, `
        select privilege, pg_catalog.has_table_privilege('ageniza_app', '${schema}.zz_least_privilege_probe'::regclass, privilege) as granted
        from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as privilege
        order by 1
      `, []);
      expect(rows.filter((row) => row.granted)).toEqual([]);
    });
  });
});

describe('the seven tables with an INSERT of the whole table and no INSERT policy (acceptance 1)', () => {
  const TABLES = ['agencies', 'agency_memberships', 'agency_storage_quotas', 'client_memberships', 'permissions', 'role_permissions', 'roles'];

  it.each(TABLES)('%s: the application role has no INSERT on any column, and keeps reading it', async (table) => {
    expect(await columnsWith(`public.${table}`, 'insert')).toEqual([]);
    const { rows } = await raw<{ rows: readonly { can_select: boolean }[] }>(getOwner().knex, `select pg_catalog.has_table_privilege('ageniza_app', ?::regclass, 'select') as can_select`, [`public.${table}`]);
    expect(rows[0]!.can_select).toBe(true);
  });

  it.each(TABLES)('%s: an INSERT as the application role is refused by the privilege, not by a policy that a mistake could open', async (table) => {
    const error = await asApplication(`insert into public.${table} default values`);
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(new RegExp(`permission denied for table ${table}`)) });
  });
});

describe('invitations and user_context_preferences are written by column (acceptance 1)', () => {
  it('invitations: INSERT is the eight columns the routes write, and UPDATE stays revoked_at alone', async () => {
    expect(await columnsWith('public.invitations', 'insert')).toEqual(
      ['agency_id', 'client_id', 'email', 'expires_at', 'invited_by_user_id', 'purpose', 'role_id', 'token_hash']
    );
    expect(await columnsWith('public.invitations', 'update')).toEqual(['revoked_at']);
  });

  it.each(['used_at', 'accepted_by_user_id', 'revoked_at', 'id', 'created_at'])('invitations: a caller cannot choose %s on INSERT', async (column) => {
    const error = await asApplication(
      `insert into public.invitations (agency_id, purpose, email, token_hash, expires_at, ${column})
       values (gen_random_uuid(), 'collaborator_invite', 'x@x.test', 'hash', now(), null)`
    );
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied for table invitations/) });
  });

  it('invitations: the columns the routes write reach the policy, which still refuses a caller with no actor', async () => {
    const error = await asApplication(
      `insert into public.invitations (agency_id, purpose, email, role_id, client_id, token_hash, expires_at, invited_by_user_id)
       values (gen_random_uuid(), 'collaborator_invite', 'x@x.test', null, null, 'hash', now(), null)`
    );
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
  });

  it('user_context_preferences: INSERT and UPDATE are the context columns, and the person is never a column to change', async () => {
    expect(await columnsWith('public.user_context_preferences', 'insert')).toEqual(['agency_id', 'client_id', 'context_type', 'updated_at', 'user_id']);
    expect(await columnsWith('public.user_context_preferences', 'update')).toEqual(['agency_id', 'client_id', 'context_type', 'updated_at']);
    const error = await asApplication('update public.user_context_preferences set user_id = gen_random_uuid()');
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied for table user_context_preferences/) });
  });

  // Revoking the UPDATE of a whole table takes the row lock with it (42501, which turns into a 500): the column-level
  // UPDATE that is left has to keep both locks working on the two tables whose grants this issue narrows.
  it.each([
    ['invitations', 'id', 'for update'], ['invitations', 'id', 'for share'],
    ['user_context_preferences', 'user_id', 'for update'], ['user_context_preferences', 'user_id', 'for share']
  ])('%s: the application role can still take the row lock (%s %s)', async (table, key, lock) => {
    expect(await asApplication(`select ${key} from public.${table} ${lock}`)).toBe('ok');
  });

  it('user_context_preferences: the context columns are enough for the upsert of the route', async () => {
    const error = await asApplication(`
      insert into public.user_context_preferences (user_id, context_type, agency_id, client_id, updated_at)
      values (gen_random_uuid(), 'agency', gen_random_uuid(), null, now())
      on conflict (user_id) do update set context_type = excluded.context_type, agency_id = excluded.agency_id, client_id = excluded.client_id, updated_at = now()
    `);
    expect(error).toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/) });
  });
});
