/**
 * Row Level Security coverage policy.
 *
 * The foundation migration grants default privileges on `public` to `ageniza_app`, so every table a
 * future migration creates is readable and writable by the application role the moment it exists.
 * RLS is not automatic in the same way: a migration that forgets `enable`/`force row level security`
 * hands out unrestricted cross-tenant access silently. This module states the rule so CI can enforce
 * it against the real schema (issue #26, AGENTS.md, ADR 0011).
 */

export interface PublicTableRlsState {
  readonly table: string;
  readonly rowLevelSecurityEnabled: boolean;
  readonly rowLevelSecurityForced: boolean;
}

export interface RlsCoverageReport {
  /** Tables that must be fixed: RLS is missing or enabled without FORCE. */
  readonly unprotected: readonly PublicTableRlsState[];
  /** Exemptions that no longer match a table, so the list cannot rot unnoticed. */
  readonly staleExemptions: readonly string[];
}

/**
 * The only tables allowed to live in `public` without RLS. Every entry needs a reason here.
 * Anything holding tenant data is never eligible, whatever its access pattern.
 */
export const PUBLIC_TABLES_EXEMPT_FROM_RLS: readonly string[] = [
  // Knex migration bookkeeping. Created and written by the migration owner, holds migration file
  // names and batch numbers only, and carries no tenant data.
  'knex_migrations',
  'knex_migrations_lock'
];

/**
 * Ordinary and partitioned tables in `public`. Views, materialised views and foreign tables are
 * excluded: they are not RLS targets, and a view's own access is decided by its base tables.
 */
export const PUBLIC_TABLE_RLS_QUERY = `
  select
    c.relname as table,
    c.relrowsecurity as row_level_security_enabled,
    c.relforcerowsecurity as row_level_security_forced
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
  order by c.relname
`;

/**
 * FORCE is required, not just ENABLE: without it the table owner bypasses its own policies, which
 * makes the barrier depend on which role happens to be connected.
 */
const isProtected = (table: PublicTableRlsState): boolean =>
  table.rowLevelSecurityEnabled && table.rowLevelSecurityForced;

export const buildRlsCoverageReport = (
  tables: readonly PublicTableRlsState[],
  exemptions: readonly string[] = PUBLIC_TABLES_EXEMPT_FROM_RLS
): RlsCoverageReport => {
  const present = new Set(tables.map((table) => table.table));
  return {
    unprotected: tables.filter((table) => !exemptions.includes(table.table) && !isProtected(table)),
    staleExemptions: exemptions.filter((name) => !present.has(name))
  };
};

export const describeUnprotectedTables = (unprotected: readonly PublicTableRlsState[]): string =>
  [
    `${unprotected.length} table(s) in schema public are reachable by ageniza_app without Row Level Security:`,
    ...unprotected.map((table) => {
      const state = table.rowLevelSecurityEnabled
        ? 'row level security is enabled but not FORCEd, so the owner bypasses its own policies'
        : 'row level security is not enabled';
      return [
        `  - public.${table.table}: ${state}.`,
        `    Fix the migration that creates public.${table.table} if it has not been applied yet,`,
        '    otherwise add a new forward-only migration with:',
        `      alter table public.${table.table} enable row level security;`,
        `      alter table public.${table.table} force row level security;`,
        '      -- plus the policies that derive tenant access from memberships',
        `    A table that genuinely holds no tenant data goes in PUBLIC_TABLES_EXEMPT_FROM_RLS with a reason.`
      ].join('\n');
    })
  ].join('\n');

export const describeStaleExemptions = (staleExemptions: readonly string[]): string =>
  [
    'These RLS exemptions no longer match any table in schema public:',
    ...staleExemptions.map((name) => `  - ${name}`),
    'Remove them from PUBLIC_TABLES_EXEMPT_FROM_RLS so the list keeps meaning what it says.'
  ].join('\n');
