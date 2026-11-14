import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Decision 2026-11-12: a session that died (expired, or made before the credential of the account was replaced) is deleted, IP, user
// agent and city with it, 30 days later; a session that is still active never is. The instant is a parameter, so every case passes
// the `p_at` it means. The worker is `ageniza_app` with no user bound to the transaction, which is how every call here is made.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = new Date();
const ago = (milliseconds: number): Date => new Date(NOW.getTime() - milliseconds);
const ahead = (milliseconds: number): Date => new Date(NOW.getTime() + milliseconds);

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const users: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const newUser = async (passwordChangedAt?: Date): Promise<string> => {
  const id = randomUUID();
  users.push(id);
  await getOwner().knex('auth.user').insert({
    id,
    name: 'Session owner',
    email: `dead-session-${id}@example.test`,
    emailVerified: true,
    ...(passwordChangedAt === undefined ? {} : { passwordChangedAt })
  });
  return id;
};

interface SessionOptions {
  readonly expiresAt: Date;
  readonly createdAt?: Date;
}

const newSession = async (userId: string, options: SessionOptions): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('auth.session').insert({
    id,
    token: `token-${randomUUID()}`,
    userId,
    expiresAt: options.expiresAt,
    createdAt: options.createdAt ?? ago(40 * DAY_MS),
    updatedAt: new Date(),
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    city: 'Curitiba'
  });
  return id;
};

const exists = async (id: string): Promise<boolean> => (await getOwner().knex('auth.session').where({ id }).first('id')) !== undefined;

const purge = async (at: Date = NOW, limit = 500): Promise<number> => {
  const result = await getApplication().knex.raw<{ rows: Array<{ purged: number }> }>('select app_private.purge_dead_sessions(?::timestamptz, ?::integer) as purged', [at, limit]);
  return result.rows[0]?.purged ?? -1;
};

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterEach(async () => {
  await getOwner().knex('auth.session').whereIn('userId', users).delete();
});

afterAll(async () => {
  await getOwner().knex('auth.user').whereIn('id', users).delete();
  await application?.close();
  await owner?.close();
});

describe('app_private.purge_dead_sessions', () => {
  it('deletes the session expired for 30 days and 1 second, and keeps the one expired for 29 days and 23 hours', async () => {
    const user = await newUser();
    const old = await newSession(user, { expiresAt: ago(30 * DAY_MS + 1000) });
    const recent = await newSession(user, { expiresAt: ago(29 * DAY_MS + 23 * HOUR_MS) });

    expect(await purge()).toBeGreaterThanOrEqual(1);

    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it('keeps the session that expired exactly 30 days before the instant: the retention is more than 30 days', async () => {
    const user = await newUser();
    const edge = await newSession(user, { expiresAt: ago(30 * DAY_MS) });
    const justPast = await newSession(user, { expiresAt: ago(30 * DAY_MS + 1) });

    await purge();

    expect(await exists(edge)).toBe(true);
    expect(await exists(justPast)).toBe(false);
  });

  it('never deletes a session that is still active, whatever its age or how close its expiry is', async () => {
    const user = await newUser();
    const aboutToExpire = await newSession(user, { expiresAt: ahead(1000) });
    const justExpired = await newSession(user, { expiresAt: ago(1000) });
    const longLived = await newSession(user, { expiresAt: ahead(7 * DAY_MS), createdAt: ago(29 * DAY_MS) });
    const ancient = await newSession(user, { expiresAt: ahead(DAY_MS), createdAt: ago(400 * DAY_MS) });

    expect(await purge()).toBe(0);

    for (const id of [aboutToExpire, justExpired, longLived, ancient]) expect(await exists(id)).toBe(true);
  });

  it('deletes a session the credential replacement left behind only 30 days after the replacement, and keeps one made after it', async () => {
    const replacedLongAgo = await newUser(ago(31 * DAY_MS));
    const replacedRecently = await newUser(ago(10 * DAY_MS));
    const before = await newSession(replacedLongAgo, { createdAt: ago(32 * DAY_MS), expiresAt: ahead(DAY_MS) });
    const after = await newSession(replacedLongAgo, { createdAt: ago(20 * DAY_MS), expiresAt: ahead(DAY_MS) });
    const beforeButRecent = await newSession(replacedRecently, { createdAt: ago(32 * DAY_MS), expiresAt: ahead(DAY_MS) });

    await purge();

    expect(await exists(before)).toBe(false);
    expect(await exists(after)).toBe(true);
    expect(await exists(beforeButRecent)).toBe(true);
  });

  it('treats a session made at the very instant the credential was replaced as dead, and one made a millisecond later as alive', async () => {
    const replacedAt = ago(31 * DAY_MS);
    const user = await newUser(replacedAt);
    const sameInstant = await newSession(user, { createdAt: replacedAt, expiresAt: ahead(DAY_MS) });
    const justAfter = await newSession(user, { createdAt: new Date(replacedAt.getTime() + 1), expiresAt: ahead(DAY_MS) });

    await purge();

    expect(await exists(sameInstant)).toBe(false);
    expect(await exists(justAfter)).toBe(true);
  });

  it('reads the replacement of the credential in the account too, not only in the user', async () => {
    const user = await newUser();
    await getOwner().knex('auth.account').insert({
      id: randomUUID(), accountId: user, providerId: 'credential', userId: user, createdAt: ago(60 * DAY_MS), updatedAt: ago(60 * DAY_MS)
    });
    await getOwner().knex('auth.account').where({ userId: user }).update({ passwordChangedAt: ago(31 * DAY_MS) });
    const before = await newSession(user, { createdAt: ago(40 * DAY_MS), expiresAt: ahead(DAY_MS) });

    await purge();

    expect(await exists(before)).toBe(false);
  });

  it('deletes at most the batch it is given, a second round finishes the rest and a third does nothing', async () => {
    const user = await newUser();
    const dead = await Promise.all(Array.from({ length: 5 }, (_unused, index) => newSession(user, { expiresAt: ago(31 * DAY_MS + index * 1000) })));
    const alive = await newSession(user, { expiresAt: ahead(DAY_MS) });

    expect(await purge(NOW, 2)).toBe(2);
    expect((await Promise.all(dead.map(exists))).filter(Boolean)).toHaveLength(3);
    expect(await purge(NOW, 2)).toBe(2);
    expect(await purge(NOW, 2)).toBe(1);
    expect(await purge(NOW, 2)).toBe(0);

    expect((await Promise.all(dead.map(exists))).filter(Boolean)).toHaveLength(0);
    expect(await exists(alive)).toBe(true);
  });

  it('skips a session that is being renewed instead of waiting for it, and the renewal keeps it', async () => {
    const user = await newUser();
    const renewed = await newSession(user, { expiresAt: ago(31 * DAY_MS) });
    const other = await newSession(user, { expiresAt: ago(32 * DAY_MS) });

    const renewal = await getOwner().knex.transaction();
    try {
      await renewal('auth.session').where({ id: renewed }).update({ expiresAt: ahead(7 * DAY_MS) });
      expect(await purge()).toBeGreaterThanOrEqual(1);
    } finally {
      await renewal.commit();
    }

    expect(await exists(other)).toBe(false);
    expect(await exists(renewed)).toBe(true);
    await purge();
    expect(await exists(renewed)).toBe(true);
  });

  it('is refused to a request, with a user bound to the transaction', async () => {
    const caller = await newUser();
    const victim = await newSession(caller, { expiresAt: ago(31 * DAY_MS) });

    await expect(withAuthenticatedUserTransaction(
      getApplication(), createVerifiedUserClaims({ userId: caller }),
      (transaction) => transaction.raw('select app_private.purge_dead_sessions(?::timestamptz, 500)', [NOW])
    )).rejects.toMatchObject({ code: '42501' });

    expect(await exists(victim)).toBe(true);
  });

  it.each([
    ['an instant more than a minute ahead', () => ahead(2 * 60_000), 500],
    ['an instant years ahead', () => ahead(5 * 365 * DAY_MS), 500],
    ['an empty batch', () => NOW, 0],
    ['a batch over 1000', () => NOW, 1001]
  ])('refuses %s, and deletes nothing', async (_name, at, limit) => {
    const user = await newUser();
    const dead = await newSession(user, { expiresAt: ago(31 * DAY_MS) });

    await expect(purge(at(), limit)).rejects.toMatchObject({ code: '22023' });

    expect(await exists(dead)).toBe(true);
  });

  it('is open to the application role and closed to PUBLIC, which has no bypass of row level security', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ app: boolean; public_acl: boolean; bypass: boolean; empty_search_path: boolean }> }>(`
      select
        has_function_privilege('ageniza_app', 'app_private.purge_dead_sessions(timestamptz, integer)', 'execute') as app,
        coalesce((select bool_or(acl.grantee = 0) from pg_proc p, aclexplode(p.proacl) acl
          where p.oid = 'app_private.purge_dead_sessions(timestamptz, integer)'::regprocedure), false) as public_acl,
        (select rolbypassrls or rolsuper from pg_roles where rolname = 'ageniza_app') as bypass,
        (select 'search_path=""' = any(proconfig) from pg_proc where oid = 'app_private.purge_dead_sessions(timestamptz, integer)'::regprocedure) as empty_search_path
    `);
    expect(rows[0]).toEqual({ app: true, public_acl: false, bypass: false, empty_search_path: true });
  });
});
