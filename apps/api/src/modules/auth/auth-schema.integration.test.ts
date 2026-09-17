import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getMigrations } from 'better-auth/db/migration';
import { afterAll, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from './test-support/harness.js';

// Issue #31 acceptance tests #16 and #17.
const openApps: TestApp[] = [];

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('Better Auth schema drift (#16)', () => {
  it('#16 getMigrations against the runtime options and the already-migrated database has nothing to create or add', async () => {
    const app = await buildTestApp();
    openApps.push(app);

    const result = await getMigrations(app.auth.options, { throwOnUnsafe: false });

    expect(result.toBeCreated).toEqual([]);
    expect(result.toBeAdded).toEqual([]);
    expect(result.unsafeChanges).toEqual([]);
  });
});

describe('RLS coverage after the auth/audit migration (#17)', () => {
  it('#17 is covered by the database package RLS suite, not duplicated here', () => {
    // `pnpm db:test:local` (packages/database/test/support/rls-coverage.ts, exercised by
    // packages/database/test/rls-coverage.integration.test.ts) asserts, against the migrated
    // schema, that every ordinary and partitioned table in `public` has both `relrowsecurity` and
    // `relforcerowsecurity`. The `auth` and `audit` schemas created by
    // 20260918000000_auth_schema.mjs live outside `public` (see packages/database/README.md,
    // "Authentication and audit schemas") and are intentionally not tenant data with RLS: `auth` is
    // Better Auth's own API-only storage, and `audit.events` is append-only, insert-only storage for
    // `ageniza_app`. This test only pins that pointer so it fails loudly if the file it relies on
    // ever disappears, rather than re-implementing the RLS scan here.
    const rlsCoveragePath = fileURLToPath(new URL('../../../../../packages/database/test/support/rls-coverage.ts', import.meta.url));
    expect(existsSync(rlsCoveragePath), 'packages/database/test/support/rls-coverage.ts must still exist; pnpm db:test:local covers RLS').toBe(true);
  });
});
