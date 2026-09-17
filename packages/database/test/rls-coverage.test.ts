import { describe, expect, it } from 'vitest';

import {
  buildRlsCoverageReport,
  describeStaleExemptions,
  describeUnprotectedTables,
  PUBLIC_TABLES_EXEMPT_FROM_RLS,
  type PublicTableRlsState
} from './support/rls-coverage.js';

const table = (name: string, enabled: boolean, forced: boolean): PublicTableRlsState => ({
  table: name,
  rowLevelSecurityEnabled: enabled,
  rowLevelSecurityForced: forced
});

describe('RLS coverage policy', () => {
  it('accepts a table that both enables and forces row level security', () => {
    const report = buildRlsCoverageReport([table('agencies', true, true)], []);
    expect(report.unprotected).toEqual([]);
  });

  it('reports a table that has no row level security at all', () => {
    const report = buildRlsCoverageReport([table('posts', false, false)], []);
    expect(report.unprotected).toEqual([table('posts', false, false)]);
  });

  it('reports a table that enables row level security without FORCE', () => {
    // Without FORCE the owner bypasses its own policies, so the barrier depends on the connected role.
    const report = buildRlsCoverageReport([table('posts', true, false)], []);
    expect(report.unprotected).toEqual([table('posts', true, false)]);
  });

  it('passes an unprotected table only when it is on the explicit exemption list', () => {
    const tables = [table('knex_migrations', false, false), table('media_assets', false, false)];
    const report = buildRlsCoverageReport(tables, ['knex_migrations']);
    expect(report.unprotected).toEqual([table('media_assets', false, false)]);
  });

  it('flags an exemption that no longer matches a table', () => {
    const report = buildRlsCoverageReport([table('knex_migrations', false, false)], ['knex_migrations', 'removed_table']);
    expect(report.staleExemptions).toEqual(['removed_table']);
  });

  it('exempts only the Knex bookkeeping tables by default', () => {
    expect([...PUBLIC_TABLES_EXEMPT_FROM_RLS]).toEqual(['knex_migrations', 'knex_migrations_lock']);
  });

  it('names the table and the exact statements needed to fix it', () => {
    const message = describeUnprotectedTables([table('media_assets', false, false)]);
    expect(message).toContain('public.media_assets');
    expect(message).toContain('alter table public.media_assets force row level security;');
    expect(message).toContain('forward-only migration');
  });

  it('names each stale exemption', () => {
    expect(describeStaleExemptions(['removed_table'])).toContain('removed_table');
  });
});
