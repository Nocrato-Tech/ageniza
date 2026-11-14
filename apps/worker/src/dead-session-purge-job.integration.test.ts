import { randomUUID } from 'node:crypto';

import { createLogger } from '@ageniza/core';
import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '@ageniza/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEAD_SESSION_PURGE_JOB_NAME, deadSessionPurgeJob } from './dead-session-purge-job.js';

// Decision 2026-11-12, against the migrated local database and as the application role, the one the worker uses in production: the job
// asks with the clock of the database, so the sessions are made 31 days and 1 day dead and the case does not depend on the hour it runs.
// The rules of the function itself are in `packages/database/test/dead-session-purge.integration.test.ts`.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();
const DAY_MS = 86_400_000;

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let userId = '';

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const session = async (expiredDaysAgo: number): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('auth.session').insert({
    id,
    token: `worker-purge-${randomUUID()}`,
    userId,
    expiresAt: new Date(Date.now() - expiredDaysAgo * DAY_MS),
    createdAt: new Date(Date.now() - 40 * DAY_MS),
    updatedAt: new Date(),
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    city: 'Curitiba'
  });
  return id;
};
const exists = async (id: string): Promise<boolean> => (await getOwner().knex('auth.session').where({ id }).first('id')) !== undefined;

const run = async (): Promise<void> => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  await deadSessionPurgeJob({ database: application }).handler(
    { id: 'job-1', name: DEAD_SESSION_PURGE_JOB_NAME, payload: {}, attempt: 1 },
    { logger: createLogger({}, { write: () => undefined } as never), signal: new AbortController().signal }
  );
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  userId = randomUUID();
  await getOwner().knex('auth.user').insert({ id: userId, name: 'Worker purge', email: `worker-session-purge-${userId}@example.test`, emailVerified: true });
});

afterAll(async () => {
  await getOwner().knex('auth.user').where({ id: userId }).delete();
  await application?.close();
  await owner?.close();
});

describe('sessions.purge-dead against the database', () => {
  it('deletes the session dead for 31 days, keeps the one dead for 1 day and the active one, and the second run changes nothing', async () => {
    const old = await session(31);
    const recent = await session(1);
    const active = await session(-7);

    await run();
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(active)).toBe(true);

    await run();
    expect(await exists(recent)).toBe(true);
    expect(await exists(active)).toBe(true);
  });
});
