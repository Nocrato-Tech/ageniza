import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lockAgencyStorageQuota } from '../../../apps/api/src/modules/media/service.js';
import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const userId = randomUUID();
const agencyId = randomUUID();

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(
  work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]
): Promise<TResult> => withAuthenticatedUserTransaction(
  getApplication(),
  createVerifiedUserClaims({ userId }),
  work
);

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  await getOwner().knex('auth.user').insert({
    id: userId,
    name: 'Quota Lock Test User',
    email: `quota-lock-${userId}@example.test`,
    emailVerified: true
  });
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Quota Lock Test Agency', owner_user_id: userId });
});

afterAll(async () => {
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').where({ id: userId }).delete();
  await application?.close();
  await owner?.close();
});

describe('media quota advisory lock', () => {
  it('proves the old row lock was filtered by RLS', async () => {
    await expect(asUser(async (transaction) => {
      const visible = await raw<{ rows: readonly { id: string }[] }>(transaction, `
        select id from public.agencies where id = ?::uuid
      `, [agencyId]);
      const forUpdate = await raw<{ rows: readonly { id: string }[] }>(transaction, `
        select id from public.agencies where id = ?::uuid for update
      `, [agencyId]);
      return { visibleCount: visible.rows.length, forUpdateCount: forUpdate.rows.length };
    })).resolves.toEqual({ visibleCount: 1, forUpdateCount: 0 });
  });

  it('serializes application transactions with the advisory lock', async () => {
    let releaseFirst!: () => void;
    let markFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => { markFirstReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = asUser(async (transaction) => {
      await lockAgencyStorageQuota(transaction, agencyId);
      markFirstReady();
      await release;
    });

    await firstReady;
    try {
      await expect(asUser(async (transaction) => {
        await raw(transaction, "set local lock_timeout = '200ms'", []);
        await lockAgencyStorageQuota(transaction, agencyId);
      })).rejects.toMatchObject({ code: '55P03' });
    } finally {
      releaseFirst();
      await first;
    }
  });
});
