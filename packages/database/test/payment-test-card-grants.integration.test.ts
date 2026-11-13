import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveIntegrationDatabaseUrls } from '../src/index.js';

// Scope redesign-igual, subtask W5-S1 (acceptance b). A whole-table grant hides from a per-column reading, so the catalog is read both ways, for the
// application role and for PUBLIC, before and after the migration of the test card: the migration may add its own objects and must change the
// grant, the policy, the RLS flag or the owner of nothing that already existed.
const { ownerUrl } = resolveIntegrationDatabaseUrls();
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const THIS_MIGRATION = '20261112000300_payment_test_card.mjs';

const databaseName = `ageniza_cardgrants_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const workDir = mkdtempSync(join(tmpdir(), 'ageniza-cardgrants-'));
let admin: Knex;
let scratch: Knex;

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

type Snapshot = Map<string, string>;

const snapshot = async (database: Knex): Promise<Snapshot> => {
  const taken: Snapshot = new Map();
  for (const sql of [TABLES_SQL, FUNCTIONS_SQL, DEFAULTS_SQL]) {
    const { rows } = await database.raw<{ rows: Array<{ key: string; value: unknown }> }>(sql);
    for (const row of rows) taken.set(row.key, JSON.stringify(row.value));
  }
  return taken;
};

let before: Snapshot;
let after: Snapshot;

beforeAll(async () => {
  const earlier = join(workDir, 'earlier');
  const through = join(workDir, 'through');
  mkdirSync(earlier);
  mkdirSync(through);
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.mjs'))) {
    if (file < THIS_MIGRATION) cpSync(join(migrationsDir, file), join(earlier, file));
    if (file <= THIS_MIGRATION) cpSync(join(migrationsDir, file), join(through, file));
  }

  admin = knex({ client: 'pg', connection: { connectionString: ownerUrl }, pool: { min: 0, max: 1 } });
  await admin.raw(`create database "${databaseName}"`);
  const target = new URL(ownerUrl);
  target.pathname = `/${databaseName}`;
  scratch = knex({ client: 'pg', connection: { connectionString: target.toString() }, pool: { min: 0, max: 2 } });

  await scratch.migrate.latest({ directory: earlier, loadExtensions: ['.mjs'] });
  expect(await scratch.schema.hasTable('agency_test_cards')).toBe(false);
  before = await snapshot(scratch);
  await scratch.migrate.latest({ directory: through, loadExtensions: ['.mjs'] });
  after = await snapshot(scratch);
}, 300_000);

afterAll(async () => {
  try {
    await scratch?.destroy();
    await admin?.raw(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin?.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('what the migration of the test card does to the privileges of the catalog', () => {
  it('has a snapshot worth comparing: the tables and the functions of the schemas, and their defaults', () => {
    expect(before.size).toBeGreaterThan(100);
    expect(before.get('table public.subscription_charges')).toContain('"SELECT":true');
    expect(before.get('function app_private.quote_subscription_change(p_agency_id uuid, p_plan_key text, p_extra_clients integer, p_extra_storage_gib integer)')).toContain('"app":true');
  });

  it('adds one table and three functions, and no other object', () => {
    expect([...after.keys()].filter((key) => !before.has(key)).sort()).toEqual([
      'function app_private.period_days_left(p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_at timestamp with time zone)',
      'function app_private.period_length_days(p_period_start timestamp with time zone, p_period_end timestamp with time zone)',
      'function app_private.save_agency_test_card(p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text)',
      'table public.agency_test_cards'
    ]);
    expect([...before.keys()].filter((key) => !after.has(key))).toEqual([]);
  });

  it('changes no grant, no policy, no RLS flag, no owner and no default privilege of what already existed', () => {
    const changed = [...before.entries()].filter(([key, value]) => after.get(key) !== value).map(([key]) => key);
    expect(changed).toEqual([]);
  });

  it('gives the new table to the application role as a SELECT of five columns and nothing else, and nothing to PUBLIC', () => {
    const table = JSON.parse(after.get('table public.agency_test_cards')!) as {
      rls: boolean[]; app: Record<string, boolean>; public: Record<string, boolean>; columns: Record<string, Record<string, boolean>>; policies: unknown[][];
    };
    expect(table.rls).toEqual([true, true]);
    expect(Object.values(table.app).filter(Boolean)).toEqual([]);
    expect(Object.values(table.public).filter(Boolean)).toEqual([]);
    expect(Object.entries(table.columns).filter(([, privileges]) => privileges.SELECT).map(([name]) => name).sort()).toEqual(['agency_id', 'brand', 'exp_month', 'exp_year', 'last4']);
    expect(Object.entries(table.columns).filter(([, privileges]) => privileges.INSERT || privileges.UPDATE || privileges.REFERENCES)).toEqual([]);
    expect(table.policies.map((policy) => [policy[0], policy[1]])).toEqual([['agency_test_cards_select', 'r']]);
    expect(table.policies[0]![3]).toContain("'assinatura.gerenciar'");
  });

  it('opens the writer to the application role only, and the two helpers to nobody', () => {
    const grants = (signature: string) => JSON.parse(after.get(`function ${signature}`)!) as { app: boolean; public: boolean; definer: boolean; config: string[] | null };
    expect(grants('app_private.save_agency_test_card(p_agency_id uuid, p_last4 text, p_exp_month integer, p_exp_year integer, p_brand text)'))
      .toEqual({ app: true, public: false, definer: true, config: ['search_path=""'], owner: expect.any(String) });
    for (const helper of [
      'app_private.period_days_left(p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_at timestamp with time zone)',
      'app_private.period_length_days(p_period_start timestamp with time zone, p_period_end timestamp with time zone)'
    ]) {
      expect(grants(helper)).toMatchObject({ app: false, public: false });
    }
  });
});
