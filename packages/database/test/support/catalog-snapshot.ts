import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';

import { resolveIntegrationDatabaseUrls } from '../../src/index.js';

// What a migration did to the catalog: a scratch database migrated up to the migration before and through the migration, read both ways. A
// whole-table grant hides from a per-column reading, so the privileges are read for the application role and for PUBLIC, per column.
const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const TABLES_SQL = `
  select format('table %s.%s', n.nspname, c.relname) as key,
         jsonb_build_object(
           'rls', jsonb_build_array(c.relrowsecurity, c.relforcerowsecurity),
           'owner', pg_catalog.pg_get_userbyid(c.relowner),
           'app', (select jsonb_object_agg(p, pg_catalog.has_table_privilege('ageniza_app', c.oid, p))
                   from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p),
           'public', (select jsonb_object_agg(p, pg_catalog.has_table_privilege('public', c.oid, p))
                      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p),
           'columns', (select coalesce(jsonb_object_agg(a.attname, (
                         select jsonb_object_agg(p, pg_catalog.has_column_privilege('ageniza_app', c.oid, a.attnum, p))
                         from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p)), '{}')
                       from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
           'public_columns', (select coalesce(jsonb_object_agg(a.attname, (
                                select jsonb_object_agg(p, pg_catalog.has_column_privilege('public', c.oid, a.attnum, p))
                                from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p)), '{}')
                              from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
           'policies', (select coalesce(jsonb_agg(jsonb_build_array(pol.polname, pol.polcmd, pol.polroles::text,
                          pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)) order by pol.polname), '[]')
                        from pg_catalog.pg_policy pol where pol.polrelid = c.oid)
         ) as value
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'auth', 'audit', 'app_private') and c.relkind in ('r', 'p', 'v', 'm')
`;

const FUNCTIONS_SQL = `
  select format('function %s.%s(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as key,
         jsonb_build_object(
           'app', pg_catalog.has_function_privilege('ageniza_app', p.oid, 'EXECUTE'),
           'public', pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE'),
           'definer', p.prosecdef,
           'config', p.proconfig,
           'owner', pg_catalog.pg_get_userbyid(p.proowner)
         ) as value
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app_private', 'audit') and p.prokind in ('f', 'p')
`;

const DEFAULTS_SQL = `
  select format('default %s %s', d.defaclnamespace::regnamespace::text, d.defaclobjtype) as key, to_jsonb(d.defaclacl::text) as value
  from pg_catalog.pg_default_acl d
`;

// What the objects are, as opposed to who may use them: the columns, the constraints, the indexes, the triggers and the text of every function.
const COLUMNS_SQL = `
  select format('column %s.%s.%s', c.table_schema, c.table_name, c.column_name) as key,
         to_jsonb(format('%s | nullable %s | default %s | generated %s', c.data_type, c.is_nullable, coalesce(c.column_default, '-'), c.is_generated)) as value
  from information_schema.columns c where c.table_schema in ('public', 'auth', 'audit', 'app_private')
`;

const CONSTRAINTS_SQL = `
  select format('constraint %s.%s.%s', n.nspname, cl.relname, con.conname) as key, to_jsonb(pg_catalog.pg_get_constraintdef(con.oid)) as value
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class cl on cl.oid = con.conrelid join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
  where n.nspname in ('public', 'auth', 'audit', 'app_private')
`;

const INDEXES_SQL = `
  select format('index %s.%s', i.schemaname, i.indexname) as key, to_jsonb(i.indexdef) as value
  from pg_catalog.pg_indexes i where i.schemaname in ('public', 'auth', 'audit', 'app_private')
`;

const TRIGGERS_SQL = `
  select format('trigger %s.%s.%s', n.nspname, cl.relname, t.tgname) as key, to_jsonb(pg_catalog.pg_get_triggerdef(t.oid)) as value
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class cl on cl.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
  where not t.tgisinternal and n.nspname in ('public', 'auth', 'audit', 'app_private')
`;

const BODIES_SQL = `
  select format('body %s.%s(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as key, to_jsonb(p.prosrc) as value
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app_private', 'audit') and p.prokind in ('f', 'p')
`;

export type Snapshot = Map<string, string>;

const read = async (database: Knex, queries: readonly string[]): Promise<Snapshot> => {
  const taken: Snapshot = new Map();
  for (const sql of queries) {
    const { rows } = await database.raw<{ rows: Array<{ key: string; value: unknown }> }>(sql);
    for (const row of rows) taken.set(row.key, JSON.stringify(row.value));
  }
  return taken;
};

export const snapshot = (database: Knex): Promise<Snapshot> => read(database, [TABLES_SQL, FUNCTIONS_SQL, DEFAULTS_SQL]);

export const snapshotStructure = (database: Knex): Promise<Snapshot> => read(database, [COLUMNS_SQL, CONSTRAINTS_SQL, INDEXES_SQL, TRIGGERS_SQL, BODIES_SQL]);

export const addedKeys = (before: Snapshot, after: Snapshot): string[] => [...after.keys()].filter((key) => !before.has(key)).sort();
export const removedKeys = (before: Snapshot, after: Snapshot): string[] => [...before.keys()].filter((key) => !after.has(key)).sort();
export const changedKeys = (before: Snapshot, after: Snapshot): string[] => [...before.entries()].filter(([key, value]) => after.has(key) && after.get(key) !== value).map(([key]) => key).sort();

export interface MigratedAcross {
  readonly scratch: Knex;
  /** The scratch database as it was before the migration, migrated through everything older. */
  readonly before: { readonly privileges: Snapshot; readonly structure: Snapshot };
  /** The same database after the migration. */
  readonly after: { readonly privileges: Snapshot; readonly structure: Snapshot };
  cleanUp(): Promise<void>;
}

/**
 * Migrates a scratch database up to the migration before `migration`, reads the catalog, migrates through `migration` and reads it again.
 * `beforeMigration` runs on the scratch database in between, for what must not exist yet.
 */
export const migrateAcross = async (
  migration: string,
  label: string,
  beforeMigration?: (scratch: Knex) => Promise<void>
): Promise<MigratedAcross> => {
  const { ownerUrl } = resolveIntegrationDatabaseUrls();
  const databaseName = `ageniza_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const workDir = mkdtempSync(join(tmpdir(), `ageniza-${label}-`));
  const earlier = join(workDir, 'earlier');
  const through = join(workDir, 'through');
  mkdirSync(earlier);
  mkdirSync(through);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs'))) {
    if (file < migration) cpSync(join(migrationsDir, file), join(earlier, file));
    if (file <= migration) cpSync(join(migrationsDir, file), join(through, file));
  }

  const admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  let scratch: Knex | undefined;
  const cleanUp = async (): Promise<void> => {
    try {
      await scratch?.destroy();
      await admin.raw(`drop database if exists "${databaseName}" with (force)`);
    } finally {
      await admin.destroy();
      rmSync(workDir, { recursive: true, force: true });
    }
  };
  try {
    await admin.raw(`create database "${databaseName}"`);
    const target = new URL(ownerUrl);
    target.pathname = `/${databaseName}`;
    scratch = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });

    await scratch.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });
    await beforeMigration?.(scratch);
    const before = { privileges: await snapshot(scratch), structure: await snapshotStructure(scratch) };
    await scratch.migrate.latest({ directory: through, loadExtensions: ['.mjs'] });
    const after = { privileges: await snapshot(scratch), structure: await snapshotStructure(scratch) };
    return { scratch, before, after, cleanUp };
  } catch (error) {
    await cleanUp();
    throw error;
  }
};
