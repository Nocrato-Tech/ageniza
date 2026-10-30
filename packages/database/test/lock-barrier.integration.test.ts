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
    // A role is a row of a catalog every database shares, so a lock on it is the one lock a backend of ANOTHER database can wait
    // behind: the pid of the holder alone does not tell the databases apart, only the `datname` of the helper does.
    const role = `lock_barrier_role_${randomUUID().replace(/-/g, '')}`;
    await owner.knex.raw(`create role ${role}`);
    const holder = await owner.knex.transaction();
    open.push(holder);
    let decoyBlocked: Promise<void> = Promise.resolve();
    try {
      await holder.raw(`alter role ${role} password 'held-by-this-database'`);
      const holderPid = await backendPid(holder);
      decoyBlocked = decoy.knex.transaction(async (transaction) => {
        await transaction.raw(`alter role ${role} password 'waiting-in-the-decoy'`);
      });
      decoyBlocked.catch(() => undefined);
      // The decoy really waits behind this holder: seen from its own database the helper counts it.
      expect(await waitForBackendsBlockedBy(decoy.knex, holderPid)).toHaveLength(1);

      await expect(waitForBackendsBlockedBy(owner.knex, holderPid, { timeoutMs: 300 })).rejects.toThrow(nobodyWaits);
    } finally {
      // The role cannot be dropped while the holder or the waiting decoy still touch it, and a failed assertion must not leave them there.
      if (!holder.isCompleted()) await holder.rollback();
      await decoyBlocked.catch(() => undefined);
      await owner.knex.raw(`drop role if exists ${role}`);
    }
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

describe('the deadlock_timeout of the holder', () => {
  const shown = async (trx: Pick<Knex, 'raw'>): Promise<string> => ((await trx.raw('show deadlock_timeout')) as { rows: Array<{ deadlock_timeout: string }> }).rows[0]!.deadlock_timeout;

  it('is longer than the server\'s inside the holder\'s transaction, and goes back to the server\'s when it ends', async () => {
    const key = randomUUID();
    const serverDefault = await shown(owner.knex);
    const holder = await holding(key);
    const blocked = blockedBehind(key);

    await requestLockOnceBlocked(holder, 'select 1 where %L is not null', ['anything']);
    expect(await shown(holder)).toBe('10s');
    await holder.rollback();
    await blocked;

    expect(await shown(owner.knex)).toBe(serverDefault);
    expect(serverDefault).not.toBe('10s');
  }, 30_000);

  it('takes the value the caller asks for', async () => {
    const key = randomUUID();
    const holder = await holding(key);
    const blocked = blockedBehind(key);

    await requestLockOnceBlocked(holder, 'select 1 where %L is not null', ['anything'], { holderDeadlockTimeoutSeconds: 4 });
    expect(await shown(holder)).toBe('4s');
    await holder.rollback();
    await blocked;
  }, 30_000);

  it('makes the waiter the victim even when the waiter\'s own deadlock_timeout is the longer of the two, which is what a busy machine does to it', async () => {
    // The waiter checks for a deadlock 3s after it starts to wait, the server's default (1s) is the holder's without the fix:
    // the holder's check would run first, with the cycle closed, and the holder would die of its own 40P01.
    expect(Number.parseFloat(await shown(owner.knex))).toBeLessThan(3);
    const first = randomUUID();
    const second = randomUUID();
    const holder = await holding(first);
    const waiter = owner.knex.transaction(async (trx) => {
      await trx.raw("set local deadlock_timeout = '3s'");
      await advisory(trx, second);
      await advisory(trx, first);
    });
    const outcome = waiter.then(() => 'committed', (error: { code?: string }) => error.code);

    await requestLockOnceBlocked(holder, ADVISORY, [second]);

    expect(await outcome).toBe('40P01');
    await holder.rollback();
  }, 30_000);
});
