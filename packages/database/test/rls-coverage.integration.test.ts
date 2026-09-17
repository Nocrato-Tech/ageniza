import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, raw, type DatabaseClient } from '../src/index.js';

import {
  buildRlsCoverageReport,
  describeStaleExemptions,
  describeUnprotectedTables,
  PUBLIC_TABLE_RLS_QUERY,
  type PublicTableRlsState
} from './support/rls-coverage.js';

// Runs against the real schema after `pnpm db:migrate`, so it measures coverage rather than the
// mechanism: a migration that creates a table and forgets RLS fails here (issue #26).
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

interface PublicTableRlsRow {
  readonly table: string;
  readonly row_level_security_enabled: boolean;
  readonly row_level_security_forced: boolean;
}

let owner: DatabaseClient | undefined;
let tables: PublicTableRlsState[] = [];

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  const result = await raw<{ rows: PublicTableRlsRow[] }>(owner.knex, PUBLIC_TABLE_RLS_QUERY, []);
  tables = result.rows.map((row) => ({
    table: row.table,
    rowLevelSecurityEnabled: row.row_level_security_enabled,
    rowLevelSecurityForced: row.row_level_security_forced
  }));
});

afterAll(async () => {
  await owner?.close();
});

describe('row level security coverage in schema public', () => {
  it('has the migrated schema available to inspect', () => {
    // Guards against a green run against an empty database that never had migrations applied.
    expect(tables.map((table) => table.table)).toContain('knex_migrations');
  });

  it('protects every table that is not explicitly exempt', () => {
    const { unprotected } = buildRlsCoverageReport(tables);
    // Thrown rather than asserted so the failure output is the actionable message, not a diff.
    if (unprotected.length > 0) throw new Error(describeUnprotectedTables(unprotected));
    expect(unprotected).toEqual([]);
  });

  it('keeps the exemption list free of tables that no longer exist', () => {
    const { staleExemptions } = buildRlsCoverageReport(tables);
    if (staleExemptions.length > 0) throw new Error(describeStaleExemptions(staleExemptions));
    expect(staleExemptions).toEqual([]);
  });
});
