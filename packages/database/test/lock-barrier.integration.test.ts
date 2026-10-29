import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  backendPid,
  createLocalTestDatabaseClient,
  requestLockOnceBlocked,
  resolveIntegrationDatabaseUrls,
  waitForBackendsBlockedBy,
  type DatabaseClient
} from '../src/index.js';

// Issue #762: a deadlock test closes the cycle from the holder's transaction, inside the database, the moment the
// transaction under test is blocked. Advisory locks stand in for the rows of a route, so the file needs no fixture.
const { ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient;
let decoy: DatabaseClient;
const decoyName = `lock_barrier_decoy_${randomUUID().replace(/-/g, '')}`;
const open: Knex.Transaction[] = [];

const ADVISORY = 'select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%L, 0))';
const advisory = (trx: Pick<Knex, 'raw'>, key: string) => trx.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [key]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const holdingIn = async (database: DatabaseClient, key: string): Promise<Knex.Transaction> => {
  const holder = await database.knex.transaction();
  open.push(holder);
  await advisory(holder, key);
  return holder;
};
const holding = (key: string): Promise<Knex.Transaction> => holdingIn(owner, key);

const blockedBehindIn = (database: DatabaseClient, key: string): Promise<void> => {
  const blocked = database.knex.transaction(async (transaction) => {
    await transaction.raw("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0)), 'marker-of-the-blocked-one'", [key]);
  });
  blocked.catch(() => undefined);
  return blocked;
};
const blockedBehind = (key: string): Promise<void> => blockedBehindIn(owner, key);

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  await owner.knex.raw(`create database ${decoyName}`);
  const decoyUrl = new URL(ownerUrl);
  decoyUrl.pathname = `/${decoyName}`;
  decoy = createLocalTestDatabaseClient(decoyUrl.toString());
});

afterAll(async () => {
  for (const transaction of open) if (!transaction.isCompleted()) await transaction.rollback();
  await decoy.close();
  await owner.knex.raw(`drop database if exists ${decoyName} with (force)`);
  await owner.close();
});

describe('requestLockOnceBlocked', () => {
  it('makes the holder close the cycle in the database, so the backend that waited first loses even when the test process stalls for 1.5 s', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const holder = await holding(first);

    const asks = requestLockOnceBlocked(holder, ADVISORY, [second]);
    const waiter = owner.knex.transaction(async (transaction) => {
      await advisory(transaction, second);
      await advisory(transaction, first);
    });
    waiter.catch(() => undefined);
    await sleep(1500);

    const [waiterOutcome, holderOutcome] = await Promise.allSettled([waiter, asks]);
    expect(waiterOutcome).toMatchObject({ status: 'rejected', reason: { code: '40P01' } });
    expect(holderOutcome.status).toBe('fulfilled');
    await holder.rollback();
  }, 30_000);

  it('does not run the statement and raises when no backend is ever blocked by the holder', async () => {
    const holder = await holding(randomUUID());

    await expect(requestLockOnceBlocked(holder, 'select 1 / 0', [], { timeoutSeconds: 1 })).rejects.toThrow(/No backend ever waited on a lock held by this transaction/);
    await holder.rollback();
  }, 30_000);

  it('ignores a blocked backend whose statement does not match the pattern', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);

    await expect(requestLockOnceBlocked(holder, 'select 1', [], { blockedStatement: '%marker-of-another-statement%', timeoutSeconds: 1 }))
      .rejects.toThrow(/No backend ever waited/);
    await holder.rollback();
    await blocked;
  }, 30_000);

  it('runs the statement for a blocked backend that matches the pattern, and takes the bindings as quoted literals', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);
    const value = `it's "quoted"; select 1 / 0 --`;

    await requestLockOnceBlocked(holder, "select pg_catalog.set_config('ageniza_test.bound', %L, true)", [value], { blockedStatement: '%marker-of-the-blocked-one%' });
    const read = await holder.raw<{ rows: Array<{ value: string }> }>("select pg_catalog.current_setting('ageniza_test.bound') as value");
    expect(read.rows[0]?.value).toBe(value);

    await holder.rollback();
    await blocked;
  }, 30_000);
});

describe('waitForBackendsBlockedBy (#767)', () => {
  const nobodyWaits = /Fewer than 1 backend\(s\) ever waited on a lock held by backend/;

  it('resolves with the pid of the backend that waits on the lock of the holder, whatever statement it runs', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);

    const pids = await waitForBackendsBlockedBy(owner.knex, await backendPid(holder));
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(await backendPid(holder));

    await holder.rollback();
    await blocked;
  }, 30_000);

  it('waits for as many backends as asked, and raises while there are fewer', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const holderPid = await backendPid(holder);
    const first = blockedBehind(key);
    await waitForBackendsBlockedBy(owner.knex, holderPid);

    await expect(waitForBackendsBlockedBy(owner.knex, holderPid, { waiters: 2, timeoutMs: 300 })).rejects.toThrow(/Fewer than 2 backend\(s\)/);
    const second = blockedBehind(key);
    await expect(waitForBackendsBlockedBy(owner.knex, holderPid, { waiters: 2 })).resolves.toHaveLength(2);

    await holder.rollback();
    await Promise.all([first, second]);
  }, 30_000);

  it('ignores a backend that waits on another holder of the same database', async () => {
    const idle = await holding(randomUUID());
    const busyKey = randomUUID();
    const busy = await holding(busyKey);
    const blocked = blockedBehind(busyKey);
    await waitForBackendsBlockedBy(owner.knex, await backendPid(busy));

    await expect(waitForBackendsBlockedBy(owner.knex, await backendPid(idle), { timeoutMs: 300 })).rejects.toThrow(nobodyWaits);

    await busy.rollback();
    await idle.rollback();
    await blocked;
  }, 30_000);

  it('ignores a wait of another database of the same server, which is the one a shared server shows', async () => {
    const decoyKey = randomUUID();
    const decoyHolder = await holdingIn(decoy, decoyKey);
    const decoyBlocked = blockedBehindIn(decoy, decoyKey);
    await waitForBackendsBlockedBy(decoy.knex, await backendPid(decoyHolder));
    const stillWaiting = await owner.knex.raw<{ rows: Array<{ waiting: number }> }>("select count(*)::int as waiting from pg_catalog.pg_stat_activity where datname = ? and wait_event_type = 'Lock'", [decoyName]);
    expect(stillWaiting.rows[0]?.waiting).toBe(1);

    const idle = await holding(randomUUID());
    await expect(waitForBackendsBlockedBy(owner.knex, await backendPid(idle), { timeoutMs: 300 })).rejects.toThrow(nobodyWaits);

    await idle.rollback();
    await decoyHolder.rollback();
    await decoyBlocked;
  }, 30_000);

  it('ignores a blocked backend whose statement does not match the pattern, and takes the one that does', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const holderPid = await backendPid(holder);
    const blocked = blockedBehind(key);

    await expect(waitForBackendsBlockedBy(owner.knex, holderPid, { blockedStatement: '%marker-of-another-statement%', timeoutMs: 300 })).rejects.toThrow(nobodyWaits);
    await expect(waitForBackendsBlockedBy(owner.knex, holderPid, { blockedStatement: '%marker-of-the-blocked-one%' })).resolves.toHaveLength(1);

    await holder.rollback();
    await blocked;
  }, 30_000);
});
