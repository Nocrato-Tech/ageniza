import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, type DatabaseClient } from '../src/index.js';

// Security catalog assertions against the migrated schema. These protect properties no behavior test
// observes: a future migration can `grant execute ... to public` or drop `set search_path` from a
// security definer function, and every functional suite stays green while the authorization surface
// opens up. Reading the catalog is the only way to hold those properties to their word.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

interface SecurityDefinerRow {
  readonly schema: string;
  readonly name: string;
  readonly public_execute: boolean;
  readonly config: readonly string[] | null;
}

interface ActorContextPrivileges {
  readonly can_select: boolean;
  readonly can_insert: boolean;
  readonly can_update: boolean;
  readonly can_delete: boolean;
  readonly can_truncate: boolean;
  readonly can_references: boolean;
  readonly can_trigger: boolean;
  readonly any_column_select: boolean;
}

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
});

afterAll(async () => {
  await owner?.close();
});

describe('security catalog (issue #166)', () => {
  it('keeps every security definer function closed to PUBLIC and with a fixed search_path', async () => {
    const { rows } = await raw<{ rows: readonly SecurityDefinerRow[] }>(getOwner().knex, `
      select
        n.nspname as schema,
        p.proname as name,
        (
          p.proacl is null
          or exists (
            select 1
            from pg_catalog.aclexplode(p.proacl) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          )
        ) as public_execute,
        p.proconfig as config
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app_private')
        and p.prosecdef
      order by n.nspname, p.proname
    `, []);

    // Guards against the query silently matching nothing if a schema or catalog shape changes.
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const label = `${row.schema}.${row.name}`;
      expect({ function: label, publicExecute: row.public_execute }).toEqual({ function: label, publicExecute: false });
      expect({
        function: label,
        fixedSearchPath: row.config?.some((entry) => entry.startsWith('search_path=')) === true
      }).toEqual({ function: label, fixedSearchPath: true });
    }
  });

  it('gives ageniza_app no privilege at all on app_private.actor_context', async () => {
    const { rows } = await raw<{ rows: readonly ActorContextPrivileges[] }>(getOwner().knex, `
      select
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'select') as can_select,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'insert') as can_insert,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'update') as can_update,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'delete') as can_delete,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'truncate') as can_truncate,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'references') as can_references,
        has_table_privilege('ageniza_app', 'app_private.actor_context', 'trigger') as can_trigger,
        has_any_column_privilege('ageniza_app', 'app_private.actor_context', 'select') as any_column_select
    `, []);

    expect(rows[0]).toEqual({
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_references: false,
      can_trigger: false,
      any_column_select: false
    });
  });
});
