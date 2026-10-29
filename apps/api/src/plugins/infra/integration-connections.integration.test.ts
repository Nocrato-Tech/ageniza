import { afterAll, describe, expect, it } from 'vitest';

import { buildTestApp, ownerClient, type TestApp } from '../../modules/auth/test-support/harness.js';

// Issue #792: four files run at once against a server with 97 connections for non-superusers (`max_connections=100`,
// three reserved). auth.integration keeps 35 apps open until its file ends, and with the pools' default 10s idle
// timeout each held 2-3 connections for the whole file, so a few files together refused the others with 53300.
// An app that is open but idle must give its connections back within a couple of seconds.
const OPEN_APPS = 10;

const owner = ownerClient();
const apps: TestApp[] = [];

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await owner.close();
});

const connectionsOfThisDatabase = async (): Promise<number> => {
  const result = await owner.knex.raw<{ rows: Array<{ count: number }> }>(
    'select count(*)::int as count from pg_catalog.pg_stat_activity where datname = pg_catalog.current_database() and pid <> pg_catalog.pg_backend_pid()'
  );
  return Number(result.rows[0]?.count);
};

describe('the connections an idle API test app keeps (issue #792)', () => {
  it('are none for the auth pool, the domain client and the queue producer once the apps sit open and idle', async () => {
    for (let index = 0; index < OPEN_APPS; index += 1) {
      const app = await buildTestApp();
      apps.push(app);
      await app.pool.query('select 1');
      await app.database.knex.raw('select 1');
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(await connectionsOfThisDatabase()).toBeLessThanOrEqual(2);
  }, 120_000);
});
