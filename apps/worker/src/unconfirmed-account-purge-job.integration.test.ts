import { randomUUID } from 'node:crypto';

import { createLogger } from '@ageniza/core';
import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME, unconfirmedAccountPurgeJob } from './unconfirmed-account-purge-job.js';

// Issue #724, against the migrated local database and as the application role, the one the worker uses in production: the job asks
// with the clock of the database, so the accounts are made 8 days and 1 day old and the case does not depend on the hour it runs.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const DAY_MS = 86_400_000;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const created: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const account = async (ageDays: number, emailVerified: boolean): Promise<string> => {
  const id = randomUUID();
  created.push(id);
  await getOwner().knex('auth.user').insert({ id, name: 'Typed by a third party', email: `worker-purge-${id}@example.test`, emailVerified, createdAt: new Date(Date.now() - ageDays * DAY_MS) });
  return id;
};
const exists = async (id: string): Promise<boolean> => (await getOwner().knex('auth.user').where({ id }).first('id')) !== undefined;

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await getOwner().knex('audit.events').where({ action: 'account.unconfirmed_purged' }).whereIn('target_id', created).delete();
  await getOwner().knex('auth.user').whereIn('id', created).delete();
  await application?.close();
  await owner?.close();
});

describe('accounts.purge-unconfirmed against the database', () => {
  it('deletes the unconfirmed account past 7 days and keeps the recent one and the confirmed one', async () => {
    if (application === undefined) throw new Error('Application database client was not initialized.');
    const old = await account(8, false);
    const recent = await account(1, false);
    const confirmed = await account(400, true);

    await unconfirmedAccountPurgeJob({ database: application }).handler(
      { id: 'job-1', name: UNCONFIRMED_ACCOUNT_PURGE_JOB_NAME, payload: {}, attempt: 1 },
      { logger: createLogger({}, { write: () => undefined } as never), signal: new AbortController().signal }
    );

    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(confirmed)).toBe(true);
  });
});
