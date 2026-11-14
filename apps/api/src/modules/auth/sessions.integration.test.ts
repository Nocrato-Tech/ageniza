import { createHmac, randomUUID } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_SESSION_LIST_MAX, AuthSessionListResponseSchema } from '@ageniza/contracts';
import type { DatabaseClient } from '@ageniza/database';

import { createInvitationToken } from '../invitations/tokens.js';
import { revokeOwnSession } from './sessions.js';
import { installFakeGoogle, signInWithGoogle, TEST_GOOGLE, type FakeGoogle } from './test-support/fake-google.js';
import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  TEST_AUTH_SECRET,
  uniqueTestEmail,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';

// Issue #893, specs/auth.md section 14: the person sees the sessions of their own account, ends one, or ends all but this one.
// Every attack is against the real routes and the real database: another account's id, the current session, a hostile city
// header, a session that ended, an account that no longer exists, and the account an invitation created.
const origin = { origin: TEST_APP_PUBLIC_URL };
/** A write with no origin, and one from an origin the app does not know: the check that stops a page of someone else. */
const REFUSED_ORIGINS: readonly Record<string, string>[] = [{}, { origin: 'https://not-allowed.example' }];
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

// What Node hands the code for a header: the bytes of the request read as Latin-1, which is how "São Paulo" reaches it.
const onTheWire = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);

let owner: DatabaseClient;
let app: TestApp;
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const extraApps: TestApp[] = [];
let addressCounter = 0;

const nextAddress = (): string => {
  addressCounter += 1;
  return `10.93.${Math.floor(addressCounter / 250) % 250}.${(addressCounter % 250) + 1}`;
};

const makeUser = async (label: string, target: TestApp = app): Promise<TestUserFixture> => {
  const user = await insertTestUser(target.pool, target.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  return user;
};

const signedCookie = (token: string): string =>
  `ageniza.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', TEST_AUTH_SECRET).update(token).digest('base64')}`)}`;

interface Seeded {
  readonly id: string;
  readonly token: string;
  readonly cookie: string;
}

interface SeedOptions {
  /** Seconds from now: the sessions of a test are told apart by when they were created, never by the clock of this process. */
  readonly createdAfter?: number;
  readonly updatedAfter?: number;
  /** Seconds the session still has to live; negative is a session that already ended. The default is a fresh one (7 days). */
  readonly expiresIn?: number;
  readonly userAgent?: string | null;
  readonly city?: string | null;
  readonly ipAddress?: string | null;
}

/** A session row written directly, with the cookie that carries its token: the only way to make an old, ended or crowded one. */
const seed = async (userId: string, options: SeedOptions = {}): Promise<Seeded> => {
  const id = randomUUID();
  const token = `seed-${randomUUID()}`;
  await owner.knex.raw(
    `insert into auth."session" (id, token, "userId", "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent", city)
     values (?, ?, ?, now() + (?::int * interval '1 second'), now() + (?::int * interval '1 second'), now() + (?::int * interval '1 second'), ?, ?, ?)`,
    [id, token, userId, options.createdAfter ?? 0, options.updatedAfter ?? options.createdAfter ?? 0, options.expiresIn ?? 7 * 86_400, options.ipAddress ?? null, options.userAgent ?? null, options.city ?? null]
  );
  return { id, token, cookie: signedCookie(token) };
};

const idsOf = async (userId: string): Promise<string[]> =>
  (await owner.knex('auth.session').where({ userId }).select<{ id: string }[]>('id')).map((row) => row.id).sort();

const rowOf = (id: string) => owner.knex('auth.session').where({ id }).first();

const sorted = (...ids: string[]): string[] => [...ids].sort();

interface Listed {
  readonly id: string;
  readonly current: boolean;
  readonly browser: string | null;
  readonly os: string | null;
  readonly city: string | null;
  readonly lastUsedAt: string;
  readonly createdAt: string;
}

const list = (cookie: string | undefined, headers: Record<string, string> = {}, target: TestApp = app) =>
  target.app.inject({ method: 'GET', url: '/auth/sessions', headers: cookie === undefined ? headers : { cookie, ...headers } });

const listed = async (cookie: string, headers: Record<string, string> = {}): Promise<Listed[]> => {
  const response = await list(cookie, headers);
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessions: Listed[] }).sessions;
};

const revoke = (cookie: string | undefined, sessionId: string, headers: Record<string, string> = origin, target: TestApp = app) =>
  target.app.inject({ method: 'DELETE', url: `/auth/sessions/${sessionId}`, headers: cookie === undefined ? headers : { cookie, ...headers } });

const revokeOthers = (cookie: string | undefined, headers: Record<string, string> = origin, target: TestApp = app) =>
  target.app.inject({ method: 'POST', url: '/auth/sessions/revoke-others', headers: cookie === undefined ? headers : { cookie, ...headers } });

/** The status the account's own door answers with the cookie: 200 while the session lives, 401 once it is gone. */
const statusWith = async (cookie: string): Promise<number> =>
  (await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })).statusCode;

const login = async (user: TestUserFixture, headers: Record<string, string> = {}): Promise<Seeded> => {
  const before = new Set(await idsOf(user.id));
  const response = await app.app.inject({
    method: 'POST', url: '/auth/login', headers: { ...origin, ...headers }, remoteAddress: nextAddress(),
    payload: { email: user.email, password: user.password }
  });
  expect(response.statusCode).toBe(200);
  const id = (await idsOf(user.id)).find((candidate) => !before.has(candidate));
  if (id === undefined) throw new Error('The login created no session.');
  return { id, token: '', cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') };
};

/** The wait a refused request is told: what is left of a 15-minute window that opened a moment ago, so a window of any other length shows. */
const expectQuarterOfAnHour = (retryAfter: unknown): void => {
  expect(Number(retryAfter)).toBeGreaterThan(14 * 60);
  expect(Number(retryAfter)).toBeLessThanOrEqual(15 * 60);
};

const cityOf = async (id: string): Promise<string | null> => ((await rowOf(id)) as { city: string | null }).city;

/** A password change as the database sees it: the trigger stamps the date of the credential at that instant (migration 20261027120000). */
const changePassword = async (userId: string): Promise<void> => {
  const hash = await (await app.auth.$context).password.hash(`changed-${randomUUID()}`);
  await owner.knex.raw(`update auth.account set password = ? where "userId" = ? and "providerId" = 'credential'`, [hash, userId]);
};

/** The two rows that keep the date of the last replacement of the credential, which the guard reads as the greater of them. */
const setCredentialDate = async (row: 'user' | 'credential', userId: string, instantSql: string, bindings: unknown[] = []): Promise<void> => {
  await owner.knex.raw(
    row === 'user'
      ? `update auth."user" set "passwordChangedAt" = ${instantSql} where id = ?`
      : `update auth.account set "passwordChangedAt" = ${instantSql} where "userId" = ?`,
    [...bindings, userId]
  );
};

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp();
});

afterAll(async () => {
  await owner.knex('legal_acceptances').whereIn('user_id', createdUserIds).delete();
  await owner.knex('audit.events').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('invitations').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('agencies').whereIn('id', createdAgencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', createdAgencyIds).delete();
  await owner.knex('auth.user').whereIn('id', createdUserIds).delete();
  await Promise.all(extraApps.splice(0).map((extra) => extra.close()));
  await app.close();
  await owner.close();
});

describe('GET /auth/sessions', () => {
  it('answers nothing without a session, and a cookie that carries no session is no session', async () => {
    const anonymous = await list(undefined);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    expect((await list(signedCookie(`never-issued-${randomUUID()}`))).statusCode).toBe(401);
    expect((await list('ageniza.session_token=not-signed-at-all')).statusCode).toBe(401);
  });

  it('lists the sessions of the account, the newest first, and marks the one that asked', async () => {
    const user = await makeUser('list-order');
    const oldest = await seed(user.id, { createdAfter: 1, userAgent: CHROME_WINDOWS, city: 'Campinas' });
    const middle = await seed(user.id, { createdAfter: 2, userAgent: SAFARI_IPHONE, city: 'Recife' });
    const newest = await seed(user.id, { createdAfter: 3, userAgent: 'curl/8.5.0', city: null });

    const fromOldest = await listed(oldest.cookie);
    expect(fromOldest.map((session) => [session.id, session.current])).toEqual([[newest.id, false], [middle.id, false], [oldest.id, true]]);
    expect(fromOldest.map((session) => [session.browser, session.os, session.city])).toEqual([[null, null, null], ['Safari', 'iOS', 'Recife'], ['Chrome', 'Windows', 'Campinas']]);

    const fromNewest = await listed(newest.cookie);
    expect(fromNewest.map((session) => [session.id, session.current])).toEqual([[newest.id, true], [middle.id, false], [oldest.id, false]]);
    expect(fromNewest.filter((session) => session.current)).toHaveLength(1);
  });

  it('shows exactly the fields of the contract, and its response is the contract', async () => {
    const user = await makeUser('list-shape');
    const only = await seed(user.id, { userAgent: CHROME_WINDOWS, city: 'Santos' });
    const response = await list(only.cookie);

    const body = response.json() as { sessions: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['sessions']);
    expect(Object.keys(body.sessions[0] ?? {}).sort()).toEqual(['browser', 'city', 'createdAt', 'current', 'id', 'lastUsedAt', 'os']);
    expect(AuthSessionListResponseSchema.parse(body).sessions).toHaveLength(1);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('says what the last renewal and the creation were, as instants, and tells them apart', async () => {
    const user = await makeUser('list-dates');
    const other = await seed(user.id, { createdAfter: 10, updatedAfter: 50 });
    const current = await seed(user.id, { createdAfter: 20 });

    const shown = (await listed(current.cookie)).find((session) => session.id === other.id);
    const row = (await rowOf(other.id)) as { createdAt: Date; updatedAt: Date };
    expect(shown?.createdAt).toBe(row.createdAt.toISOString());
    expect(shown?.lastUsedAt).toBe(row.updatedAt.toISOString());
    expect(shown?.lastUsedAt).not.toBe(shown?.createdAt);
  });

  it('never carries the address, the token, the signature or the text of the user agent', async () => {
    const user = await makeUser('list-secrets');
    const address = '203.0.113.77';
    const marker = 'SECRET-UA-MARKER-7c1e';
    const first = await seed(user.id, { createdAfter: 1, ipAddress: address, userAgent: `${CHROME_WINDOWS} ${marker}`, city: 'Santos' });
    const second = await seed(user.id, { createdAfter: 2, ipAddress: '198.51.100.9', userAgent: SAFARI_MAC });
    const real = await login(user, { 'user-agent': `${SAFARI_IPHONE} ${marker}` });

    const response = await list(real.cookie);
    const text = response.body;
    for (const secret of [address, '198.51.100.9', marker, first.token, second.token, real.cookie.split('=')[1] ?? 'x', 'ipAddress', 'userAgent', 'token', 'user_agent', 'Mozilla']) {
      expect(text, secret).not.toContain(secret);
    }
    const owned = await owner.knex('auth.session').where({ userId: user.id }).select<{ ipAddress: string | null; token: string }[]>('ipAddress', 'token');
    for (const row of owned) {
      if (row.ipAddress !== null) expect(text).not.toContain(row.ipAddress);
      expect(text).not.toContain(row.token);
    }
  });

  it('leaves out a session that ended and keeps one that still has a minute', async () => {
    const user = await makeUser('list-expired');
    const alive = await seed(user.id, { createdAfter: 1, expiresIn: 60 });
    const ended = await seed(user.id, { createdAfter: 2, expiresIn: -1 });
    const long = await seed(user.id, { createdAfter: 3, expiresIn: -86_400 });
    const current = await seed(user.id, { createdAfter: 4 });

    const ids = (await listed(current.cookie)).map((session) => session.id);
    expect(ids).toEqual([current.id, alive.id]);
    expect(ids).not.toContain(ended.id);
    expect(ids).not.toContain(long.id);
    // Listing never deletes: the row of a session that ended is for the cleanup, not for a read.
    expect(await idsOf(user.id)).toEqual(sorted(alive.id, ended.id, long.id, current.id));
  });

  // The rule of the guard (issue #719): a session made at or before the last replacement of the credential is not the person's, even if
  // its row survived the deletion that came with the change (a sign-in with the old password that was still running).
  it('leaves out a session made before the last change of the password, which the guard refuses, and keeps the others', async () => {
    const user = await makeUser('list-race');
    const raced = await seed(user.id, { createdAfter: 0 });
    await changePassword(user.id);
    const other = await seed(user.id, { createdAfter: 2 });
    const current = await seed(user.id, { createdAfter: 3 });

    expect((await listed(current.cookie)).map((session) => session.id)).toEqual([current.id, other.id]);
    expect(await idsOf(user.id)).toContain(raced.id);
    expect((await revoke(current.cookie, raced.id)).statusCode).toBe(404);
    expect(await idsOf(user.id)).toContain(raced.id);
    expect(await statusWith(raced.cookie)).toBe(401);
    expect(await idsOf(user.id)).toEqual(sorted(other.id, current.id));
  });

  it.each([['the user', 'user'], ['the credential', 'credential']] as const)('reads the date of %s: a session made before it is not listed', async (_label, row) => {
    const user = await makeUser(`list-date-${row}`);
    const before = await seed(user.id, { createdAfter: 0 });
    await setCredentialDate(row, user.id, 'clock_timestamp()');
    const current = await seed(user.id, { createdAfter: 2 });

    expect((await listed(current.cookie)).map((session) => session.id)).toEqual([current.id]);
    expect(await statusWith(before.cookie)).toBe(401);
  });

  it('reads the greater of the two dates, whichever row holds it', async () => {
    const user = await makeUser('list-date-greater');
    const first = await seed(user.id, { createdAfter: 0 });
    await setCredentialDate('credential', user.id, 'clock_timestamp()');
    const second = await seed(user.id, { createdAfter: 1 });
    await setCredentialDate('user', user.id, `now() + interval '2 seconds'`);
    const third = await seed(user.id, { createdAfter: 3 });

    expect((await listed(third.cookie)).map((session) => session.id)).toEqual([third.id]);
    expect(await statusWith(second.cookie)).toBe(401);
    expect(await statusWith(first.cookie)).toBe(401);
  });

  it('lists the sessions of an account that has no date of a change at all, as the guard lets them through', async () => {
    const user = await makeUser('list-no-date');
    // The credential of an account older than the date: nothing was ever replaced, so nothing refuses a session.
    await setCredentialDate('credential', user.id, 'null');
    const dates = await owner.knex.raw<{ rows: { user_date: Date | null; credential_date: Date | null }[] }>(
      `select person."passwordChangedAt" as user_date, (select max(credential."passwordChangedAt") from auth.account credential where credential."userId" = person.id) as credential_date
       from auth."user" person where person.id = ?`,
      [user.id]
    );
    expect(dates.rows).toEqual([{ user_date: null, credential_date: null }]);
    const other = await seed(user.id, { createdAfter: 1 });
    const current = await seed(user.id, { createdAfter: 2 });

    expect((await listed(current.cookie)).map((session) => session.id)).toEqual([current.id, other.id]);
    expect(await statusWith(other.cookie)).toBe(200);
  });

  it.each([
    ['at the same instant', 0, false],
    ['1 ms after', 1, false],
    ['1 ms before', -1, true]
  ] as const)('lists a session the credential changed %s it was made only when the change is before it, as the guard decides', async (_when, offsetMs, listedToo) => {
    const user = await makeUser(`list-boundary-${offsetMs}`);
    const probe = await seed(user.id, { createdAfter: 0 });
    const current = await seed(user.id, { createdAfter: 3 });
    await setCredentialDate('user', user.id, `(select "createdAt" from auth."session" where id = ?::uuid) + (?::int * interval '1 millisecond')`, [probe.id, offsetMs]);

    expect((await listed(current.cookie)).some((session) => session.id === probe.id)).toBe(listedToo);
    expect(await statusWith(probe.cookie)).toBe(listedToo ? 200 : 401);
  });

  it('never shows a session of another account, and the other account sees none of these', async () => {
    const mine = await makeUser('list-mine');
    const theirs = await makeUser('list-theirs');
    const mineSeed = await seed(mine.id, { createdAfter: 1 });
    const theirSeeds = [await seed(theirs.id, { createdAfter: 2, city: 'Fortaleza' }), await seed(theirs.id, { createdAfter: 3 })];

    expect((await listed(mineSeed.cookie)).map((session) => session.id)).toEqual([mineSeed.id]);
    expect((await listed(theirSeeds[0]?.cookie ?? '')).map((session) => session.id)).toEqual([theirSeeds[1]?.id, theirSeeds[0]?.id]);
  });

  it(`shows at most ${AUTH_SESSION_LIST_MAX} sessions, the newest`, async () => {
    const user = await makeUser('list-cap');
    const bulk = await owner.knex.raw<{ rows: { id: string }[] }>(
      `insert into auth."session" (id, token, "userId", "createdAt", "updatedAt", "expiresAt")
       select gen_random_uuid(), 'bulk-' || gen_random_uuid(), ?, now() + (n * interval '1 second'), now() + (n * interval '1 second'), now() + interval '7 days'
       from generate_series(1, 105) as n
       returning id`,
      [user.id]
    );
    const current = await seed(user.id, { createdAfter: 500 });
    const byAge = (await owner.knex('auth.session').where({ userId: user.id }).orderBy('createdAt', 'asc').select<{ id: string }[]>('id')).map((row) => row.id);
    expect(bulk.rows).toHaveLength(105);

    const ids = (await listed(current.cookie)).map((session) => session.id);
    expect(ids).toHaveLength(AUTH_SESSION_LIST_MAX);
    expect(ids).toEqual([...byAge].reverse().slice(0, AUTH_SESSION_LIST_MAX));
    expect(ids[0]).toBe(current.id);
  });

  // 101 open sessions, one more than the list holds: the one that asked stays however old it is, and the oldest of the others goes.
  it.each([
    ['the oldest of them', 1],
    ['the second oldest, the 100th newest', 2],
    ['in the middle', 51],
    ['the newest', 101]
  ] as const)('keeps the session that asked on the list of 101, when it is %s', async (_label, currentAfter) => {
    const user = await makeUser(`list-crowd-${currentAfter}`);
    await owner.knex.raw(
      `insert into auth."session" (id, token, "userId", "createdAt", "updatedAt", "expiresAt")
       select gen_random_uuid(), 'crowd-' || gen_random_uuid(), ?, now() + (n * interval '1 second'), now() + (n * interval '1 second'), now() + interval '7 days'
       from generate_series(1, 101) as n
       where n <> ?`,
      [user.id, currentAfter]
    );
    const current = await seed(user.id, { createdAfter: currentAfter });
    const newestFirst = (await owner.knex('auth.session').where({ userId: user.id }).orderBy('createdAt', 'desc').select<{ id: string }[]>('id')).map((row) => row.id);
    expect(newestFirst).toHaveLength(AUTH_SESSION_LIST_MAX + 1);

    const others = newestFirst.filter((id) => id !== current.id);
    const dropped = others[others.length - 1];
    const sessions = await listed(current.cookie);
    expect(sessions).toHaveLength(AUTH_SESSION_LIST_MAX);
    expect(sessions.map((session) => session.id)).toEqual(newestFirst.filter((id) => id !== dropped));
    expect(sessions.filter((session) => session.current).map((session) => session.id)).toEqual([current.id]);
    expect(sessions.map((session) => session.id)).not.toContain(dropped);
  });

  it.each([
    ['the smallest', 0],
    ['in the middle', 3],
    ['the largest', 7]
  ] as const)('puts the session that asked among the ones that tie with it by the id, when its id is %s', async (_label, position) => {
    const user = await makeUser(`list-tie-current-${position}`);
    // One statement, so the eight share one creation instant and only the id tells them apart.
    const ids = Array.from({ length: 8 }, () => randomUUID()).sort();
    await owner.knex.raw(
      `insert into auth."session" (id, token, "userId", "createdAt", "updatedAt", "expiresAt")
       select id, 'tie-' || id::text, ?, now() + interval '5 seconds', now() + interval '5 seconds', now() + interval '7 days'
       from (values ${ids.map(() => '(?::uuid)').join(', ')}) as tied(id)`,
      [user.id, ...ids]
    );

    const shown = await listed(signedCookie(`tie-${ids[position] ?? ''}`));
    expect(shown.map((session) => session.id)).toEqual([...ids].reverse());
    expect(shown.find((session) => session.current)?.id).toBe(ids[position]);
  });

  it('breaks a tie of creation instants by the id, so the order never changes between two reads', async () => {
    const user = await makeUser('list-tie');
    // One statement, so every row gets the same `now()`: six that tie, whose chance order matching the ids is 1 in 720.
    const tied = await owner.knex.raw<{ rows: { id: string }[] }>(
      `insert into auth."session" (id, token, "userId", "createdAt", "updatedAt", "expiresAt")
       select gen_random_uuid(), 'tie-' || gen_random_uuid(), ?, now() + interval '5 seconds', now() + interval '5 seconds', now() + interval '7 days'
       from generate_series(1, 6)
       returning id`,
      [user.id]
    );
    const current = await seed(user.id, { createdAfter: 6 });

    const expected = tied.rows.map((row) => row.id).sort().reverse();
    expect(expected).toHaveLength(6);
    expect((await listed(current.cookie)).map((session) => session.id)).toEqual([current.id, ...expected]);
  });

  it('is held to 120 a quarter of an hour for the account, and the refusals of strangers count for nobody', async () => {
    const limited = await buildTestApp();
    extraApps.push(limited);
    const user = await makeUser('list-limit', limited);
    const other = await makeUser('list-limit-other', limited);
    const mine = await seed(user.id);
    const theirs = await seed(other.id);

    for (let index = 0; index < 30; index += 1) expect((await list(undefined, {}, limited)).statusCode).toBe(401);
    for (let index = 0; index < 120; index += 1) {
      const response = await list(mine.cookie, {}, limited);
      if (response.statusCode !== 200) throw new Error(`Request ${index + 1} of 120 answered ${response.statusCode}.`);
    }
    const over = await list(mine.cookie, {}, limited);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expectQuarterOfAnHour(over.headers['retry-after']);
    expect((await list(theirs.cookie, {}, limited)).statusCode).toBe(200);
  }, 60_000);
});

describe('DELETE /auth/sessions/:sessionId', () => {
  it('ends another session of the person at once and touches no other', async () => {
    const user = await makeUser('revoke-one');
    const caller = await seed(user.id, { createdAfter: 1 });
    const target = await seed(user.id, { createdAfter: 2 });
    const bystander = await seed(user.id, { createdAfter: 3 });

    const response = await revoke(caller.cookie, target.id);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, bystander.id));
    expect(await statusWith(target.cookie)).toBe(401);
    expect(await statusWith(caller.cookie)).toBe(200);
    expect(await statusWith(bystander.cookie)).toBe(200);
    expect((await listed(caller.cookie)).map((session) => session.id)).toEqual([bystander.id, caller.id]);
  });

  it('answers the same for an id in capitals, which is the same session', async () => {
    const user = await makeUser('revoke-capitals');
    const caller = await seed(user.id, { createdAfter: 1 });
    const target = await seed(user.id, { createdAfter: 2 });

    expect((await revoke(caller.cookie, target.id.toUpperCase())).statusCode).toBe(204);
    expect(await idsOf(user.id)).toEqual([caller.id]);
  });

  it('answers 409 and keeps the session when the one named is the one that asks, in any spelling', async () => {
    const user = await makeUser('revoke-current');
    const caller = await seed(user.id, { createdAfter: 1 });
    const other = await seed(user.id, { createdAfter: 2 });

    for (const spelling of [caller.id, caller.id.toUpperCase()]) {
      const response = await revoke(caller.cookie, spelling);
      expect(response.statusCode, spelling).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'USE_LOGOUT', message: 'Esta é a sessão deste aparelho. Para sair dela, use "Sair".' } });
    }
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, other.id));
    expect(await statusWith(caller.cookie)).toBe(200);
  });

  it('is refused by the statement itself, without the route, when the session named is the one that asks', async () => {
    const user = await makeUser('revoke-statement');
    const caller = await seed(user.id, { createdAfter: 1 });
    const other = await seed(user.id, { createdAfter: 2 });

    expect(await revokeOwnSession(app.database.knex, user.id, caller.id, caller.id)).toBe(false);
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, other.id));
    expect(await revokeOwnSession(app.database.knex, user.id, caller.id, other.id)).toBe(true);
    expect(await idsOf(user.id)).toEqual([caller.id]);
  });

  it('never ends the session of another account, and answers exactly as it answers for one that does not exist', async () => {
    const attacker = await makeUser('revoke-attacker');
    const victim = await makeUser('revoke-victim');
    const mine = await seed(attacker.id, { createdAfter: 1 });
    const victimSeed = await seed(victim.id, { createdAfter: 2 });
    const requestId = { ...origin, 'x-request-id': 'shared-request-id-of-the-attack' };

    const foreign = await revoke(mine.cookie, victimSeed.id, requestId);
    const missing = await revoke(mine.cookie, randomUUID(), requestId);

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: 'SESSION_NOT_FOUND', message: 'Sessão não encontrada.' } });
    expect(foreign.body).toBe(missing.body);
    expect(foreign.headers['content-length']).toBe(missing.headers['content-length']);
    expect(await idsOf(victim.id)).toEqual([victimSeed.id]);
    expect(await statusWith(victimSeed.cookie)).toBe(200);
    expect(await statusWith(mine.cookie)).toBe(200);
  });

  it('answers that same 404 for whatever is not the id of a session, and ends nothing', async () => {
    const user = await makeUser('revoke-malformed');
    const caller = await seed(user.id, { createdAfter: 1 });
    const other = await seed(user.id, { createdAfter: 2 });
    const requestId = { ...origin, 'x-request-id': 'shared-request-id-of-the-malformed' };
    const missing = await revoke(caller.cookie, randomUUID(), requestId);

    for (const malformed of ['not-a-uuid', '123', `x${other.id}`, "x';drop table auth.session;--", `${other.id}0`, other.id.slice(1), other.id.replace(/-/g, ''), `${other.id} `, '%2e%2e', 'ffffffff-ffff-4fff-8fff-fffffffffffg']) {
      const response = await revoke(caller.cookie, encodeURIComponent(malformed), requestId);
      expect({ malformed, status: response.statusCode, body: response.body }).toEqual({ malformed, status: 404, body: missing.body });
    }
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, other.id));
  });

  it('is not reached by an id too long to be one: the router refuses it, and nothing ends', async () => {
    const user = await makeUser('revoke-too-long');
    const caller = await seed(user.id);
    const response = await revoke(caller.cookie, 'a'.repeat(101));
    expect(response.statusCode).toBe(414);
    expect(await idsOf(user.id)).toEqual([caller.id]);
  });

  it('answers 404 for a session of its own that already ended, and leaves its row for the cleanup', async () => {
    const user = await makeUser('revoke-ended');
    const caller = await seed(user.id, { createdAfter: 1 });
    const ended = await seed(user.id, { createdAfter: 2, expiresIn: -60 });

    expect((await revoke(caller.cookie, ended.id)).statusCode).toBe(404);
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, ended.id));
  });

  it('refuses a body and ends nothing', async () => {
    const user = await makeUser('revoke-body');
    const caller = await seed(user.id, { createdAfter: 1 });
    const target = await seed(user.id, { createdAfter: 2 });

    const response = await app.app.inject({ method: 'DELETE', url: `/auth/sessions/${target.id}`, headers: { ...origin, cookie: caller.cookie }, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, target.id));
  });

  it('refuses a request from another origin or from none, and ends nothing', async () => {
    const user = await makeUser('revoke-csrf');
    const caller = await seed(user.id, { createdAfter: 1 });
    const target = await seed(user.id, { createdAfter: 2 });

    for (const headers of REFUSED_ORIGINS) {
      const response = await revoke(caller.cookie, target.id, headers);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    }
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, target.id));
  });

  it('answers a request with no valid session 401 and ends nothing', async () => {
    const user = await makeUser('revoke-anonymous');
    const target = await seed(user.id);
    const ended = await seed(user.id, { expiresIn: -60 });

    expect((await revoke(undefined, target.id)).statusCode).toBe(401);
    expect((await revoke(ended.cookie, target.id)).statusCode).toBe(401);
    expect((await revoke(signedCookie(`never-issued-${randomUUID()}`), target.id)).statusCode).toBe(401);
    // Better Auth deletes the ended session whose cookie it reads; what matters here is the one that was named.
    expect(await idsOf(user.id)).toContain(target.id);
  });

  it('is gone for an account that was removed: its cookie is refused, and its session is nobody else\'s to end', async () => {
    const removed = await makeUser('revoke-removed');
    const other = await makeUser('revoke-removed-other');
    const removedSeed = await seed(removed.id, { createdAfter: 1 });
    const mine = await seed(other.id, { createdAfter: 2 });
    expect((await list(removedSeed.cookie)).statusCode).toBe(200);

    await owner.knex('auth.user').where({ id: removed.id }).delete();

    expect((await list(removedSeed.cookie)).statusCode).toBe(401);
    expect((await revoke(removedSeed.cookie, mine.id)).statusCode).toBe(401);
    expect((await revoke(mine.cookie, removedSeed.id)).statusCode).toBe(404);
    expect(await idsOf(other.id)).toEqual([mine.id]);
  });

  it('is held to 30 a quarter of an hour for the account, the refusals included, and another account is not held', async () => {
    const limited = await buildTestApp();
    extraApps.push(limited);
    const user = await makeUser('revoke-limit', limited);
    const other = await makeUser('revoke-limit-other', limited);
    const mine = await seed(user.id);
    const theirs = await seed(other.id);

    for (let index = 0; index < 20; index += 1) expect((await revoke(undefined, randomUUID(), origin, limited)).statusCode).toBe(401);
    for (let index = 0; index < 30; index += 1) {
      const response = await revoke(mine.cookie, randomUUID(), origin, limited);
      if (response.statusCode !== 404) throw new Error(`Request ${index + 1} of 30 answered ${response.statusCode}.`);
    }
    const over = await revoke(mine.cookie, randomUUID(), origin, limited);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expectQuarterOfAnHour(over.headers['retry-after']);
    expect((await revoke(theirs.cookie, randomUUID(), origin, limited)).statusCode).toBe(404);
  }, 60_000);
});

describe('POST /auth/sessions/revoke-others', () => {
  it.each([['the oldest', 0], ['a middle one', 2], ['the newest', 4]] as const)('ends every session but the one that asks, when that is %s', async (_which, index) => {
    const user = await makeUser('others-keeps');
    const all: Seeded[] = [];
    for (let position = 0; position < 5; position += 1) all.push(await seed(user.id, { createdAfter: position + 1 }));
    const caller = all[index] as Seeded;

    const response = await revokeOthers(caller.cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 4 });
    expect(await idsOf(user.id)).toEqual([caller.id]);
    expect(await statusWith(caller.cookie)).toBe(200);
    for (const gone of all.filter((entry) => entry.id !== caller.id)) expect(await statusWith(gone.cookie)).toBe(401);
    expect((await listed(caller.cookie)).map((session) => [session.id, session.current])).toEqual([[caller.id, true]]);
  });

  it('answers 0 and keeps the session when there is no other', async () => {
    const user = await makeUser('others-none');
    const only = await seed(user.id);

    const response = await revokeOthers(only.cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 0 });
    expect(await idsOf(user.id)).toEqual([only.id]);
    expect(await statusWith(only.cookie)).toBe(200);
  });

  it('never touches the sessions of another account', async () => {
    const mine = await makeUser('others-mine');
    const theirs = await makeUser('others-theirs');
    const caller = await seed(mine.id, { createdAfter: 1 });
    await seed(mine.id, { createdAfter: 2 });
    const theirSeeds = [await seed(theirs.id, { createdAfter: 3 }), await seed(theirs.id, { createdAfter: 4 })];

    expect(((await revokeOthers(caller.cookie)).json())).toEqual({ revoked: 1 });

    expect(await idsOf(theirs.id)).toEqual(sorted(...theirSeeds.map((entry) => entry.id)));
    for (const entry of theirSeeds) expect(await statusWith(entry.cookie)).toBe(200);
  });

  it('clears the ended ones it finds without counting them: the number is of the sessions that were still open', async () => {
    const user = await makeUser('others-ended');
    const current = await seed(user.id, { createdAfter: 1 });
    await seed(user.id, { createdAfter: 2 });
    await seed(user.id, { createdAfter: 3 });
    await seed(user.id, { createdAfter: 4, expiresIn: -1 });
    await seed(user.id, { createdAfter: 5, expiresIn: -86_400 });

    expect((await revokeOthers(current.cookie)).json()).toEqual({ revoked: 2 });
    expect(await idsOf(user.id)).toEqual([current.id]);
  });

  it('does not count a session made before the last change of the password, which the guard refuses, and clears its row', async () => {
    const user = await makeUser('others-raced');
    await seed(user.id, { createdAfter: 0 });
    await changePassword(user.id);
    const other = await seed(user.id, { createdAfter: 2 });
    const current = await seed(user.id, { createdAfter: 3 });

    expect((await revokeOthers(current.cookie)).json()).toEqual({ revoked: 1 });
    expect(await idsOf(user.id)).toEqual([current.id]);
    expect(await statusWith(other.cookie)).toBe(401);
  });

  it('answers 0 for a person whose only other session is one the guard refuses', async () => {
    const user = await makeUser('others-raced-alone');
    const raced = await seed(user.id, { createdAfter: 0 });
    await changePassword(user.id);
    const current = await seed(user.id, { createdAfter: 2 });

    expect((await listed(current.cookie)).map((session) => session.id)).toEqual([current.id]);
    expect((await revokeOthers(current.cookie)).json()).toEqual({ revoked: 0 });
    expect(await idsOf(user.id)).toEqual([current.id]);
    expect(await rowOf(raced.id)).toBeUndefined();
  });

  it('refuses a body, another origin and no origin, and ends nothing', async () => {
    const user = await makeUser('others-refused');
    const caller = await seed(user.id, { createdAfter: 1 });
    const other = await seed(user.id, { createdAfter: 2 });

    const withBody = await app.app.inject({ method: 'POST', url: '/auth/sessions/revoke-others', headers: { ...origin, cookie: caller.cookie }, payload: {} });
    expect(withBody.statusCode).toBe(400);
    for (const headers of REFUSED_ORIGINS) {
      const response = await revokeOthers(caller.cookie, headers);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    }
    expect((await revokeOthers(undefined)).statusCode).toBe(401);
    expect(await idsOf(user.id)).toEqual(sorted(caller.id, other.id));
  });

  it('two at once end each of the others once, and never the one that asks', async () => {
    const user = await makeUser('others-parallel');
    const caller = await seed(user.id, { createdAfter: 1 });
    for (let position = 2; position <= 5; position += 1) await seed(user.id, { createdAfter: position });

    const [first, second] = await Promise.all([revokeOthers(caller.cookie), revokeOthers(caller.cookie)]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect((first.json() as { revoked: number }).revoked + (second.json() as { revoked: number }).revoked).toBe(4);
    expect(await idsOf(user.id)).toEqual([caller.id]);
    expect(await statusWith(caller.cookie)).toBe(200);
  });

  it('is held to 30 a quarter of an hour for the account', async () => {
    const limited = await buildTestApp();
    extraApps.push(limited);
    const user = await makeUser('others-limit', limited);
    const mine = await seed(user.id);

    for (let index = 0; index < 30; index += 1) {
      const response = await revokeOthers(mine.cookie, origin, limited);
      if (response.statusCode !== 200) throw new Error(`Request ${index + 1} of 30 answered ${response.statusCode}.`);
    }
    const over = await revokeOthers(mine.cookie, origin, limited);
    expect(over.statusCode).toBe(429);
    expectQuarterOfAnHour(over.headers['retry-after']);
  }, 60_000);

  it('leaves logout and logout-all as they were: one ends this session, the other ends all', async () => {
    const user = await makeUser('others-logout');
    const kept = await seed(user.id, { createdAfter: 1 });
    const leaving = await seed(user.id, { createdAfter: 2 });

    expect((await app.app.inject({ method: 'POST', url: '/auth/logout', headers: { ...origin, cookie: leaving.cookie } })).statusCode).toBe(204);
    expect(await statusWith(leaving.cookie)).toBe(401);
    expect(await statusWith(kept.cookie)).toBe(200);

    const extra = await seed(user.id, { createdAfter: 3 });
    expect((await app.app.inject({ method: 'POST', url: '/auth/logout-all', headers: { ...origin, cookie: kept.cookie } })).statusCode).toBe(204);
    expect(await statusWith(kept.cookie)).toBe(401);
    expect(await statusWith(extra.cookie)).toBe(401);
    expect(await idsOf(user.id)).toEqual([]);
  });
});

describe('the city of a sign-in (cf-ipcity)', () => {
  it('keeps what the edge sent, as text, and reads the UTF-8 that Node hands over as Latin-1', async () => {
    const user = await makeUser('city-kept');
    const accents = await login(user, { 'cf-ipcity': onTheWire('São Paulo'), 'user-agent': SAFARI_MAC });
    const plain = await login(user, { 'cf-ipcity': 'Campinas' });
    const none = await login(user);

    expect(await cityOf(accents.id)).toBe('São Paulo');
    expect(await cityOf(plain.id)).toBe('Campinas');
    expect(await cityOf(none.id)).toBeNull();
    const shown = await listed(none.cookie);
    expect(shown.find((session) => session.id === accents.id)).toMatchObject({ city: 'São Paulo', browser: 'Safari', os: 'macOS', current: false });
    expect(shown.find((session) => session.id === plain.id)).toMatchObject({ city: 'Campinas', current: false });
    expect(shown.find((session) => session.id === none.id)).toMatchObject({ city: null, current: true });
  });

  it('keeps a city of exactly 80 characters, trimmed, and nothing else the request says about where it is from', async () => {
    const user = await makeUser('city-limit');
    const edge = await login(user, { 'cf-ipcity': `  ${'ã'.repeat(40).replace(/ã/g, onTheWire('ã'))}${'b'.repeat(40)}  ` });
    const others = await login(user, {
      'cf-ipcountry': 'BR', 'cf-region': 'Sao Paulo', 'x-forwarded-city': 'Evil', 'x-ageniza-city': 'Evil', city: 'Evil', 'x-ageniza-client-ip': '203.0.113.5'
    });

    expect(await cityOf(edge.id)).toBe(`${'ã'.repeat(40)}${'b'.repeat(40)}`);
    expect(await cityOf(others.id)).toBeNull();
  });

  // The cleaning and the column count code points, and the response must too: a letter or an emoji beyond the Basic Multilingual Plane is
  // two UTF-16 units, and a response that counted those refused a city the column keeps, so the list answered 500 on every device.
  it.each([
    ['80 mathematical letters', chars(0x1d400).repeat(80)],
    ['41 emoji', chars(0x1f600).repeat(41)],
    ['80 emoji', chars(0x1f600).repeat(80)],
    ['41 ideograms of the extension B', chars(0x20000).repeat(41)],
    ['80 ideograms of the extension B', chars(0x20000).repeat(80)],
    ['79 letters and one emoji', `${'a'.repeat(79)}${chars(0x1f600)}`],
    ['a CJK name', chars(0x6771, 0x4eac, 0x90fd)]
  ])('lists a city of %s, whole, from every device of the account', async (_label, value) => {
    const user = await makeUser('city-astral');
    const bystander = await login(user);
    const entered = await login(user, { 'cf-ipcity': onTheWire(value) });
    expect(await cityOf(entered.id)).toBe(value);

    for (const cookie of [entered.cookie, bystander.cookie]) {
      const response = await list(cookie);
      expect(response.statusCode).toBe(200);
      const sessions = (response.json() as { sessions: Listed[] }).sessions;
      expect(sessions.find((session) => session.id === entered.id)?.city).toBe(value);
      expect(sessions.find((session) => session.id === bystander.id)?.city).toBeNull();
    }
  });

  const hostile: readonly (readonly [string, string])[] = [
    ['a control character', `Sao${chars(0x01)}Paulo`],
    ['an escape', `Sao${chars(0x1b)}[2JPaulo`],
    ['a delete', `Sao${chars(0x7f)}Paulo`],
    ['a C1 control, as UTF-8 on the wire', onTheWire(`Sao${chars(0x85)}Paulo`)],
    ['a right-to-left override, which reorders what follows', onTheWire(`Sao${chars(0x202e)}oluaP`)],
    ['a right-to-left isolate', onTheWire(`Sao${chars(0x2067)}Paulo`)],
    ['a right-to-left mark', onTheWire(`Sao${chars(0x200f)}Paulo`)],
    ['an Arabic letter mark', onTheWire(`Sao${chars(0x061c)}Paulo`)],
    ['a zero-width space', onTheWire(`Sao${chars(0x200b)}Paulo`)],
    ['a byte-order mark', onTheWire(`${chars(0xfeff)}Sao Paulo`)],
    ['81 characters', 'a'.repeat(81)],
    ['81 two-byte characters', onTheWire('ã'.repeat(81))],
    ['81 astral characters', onTheWire(chars(0x1f600).repeat(81))],
    ['an empty value', ''],
    ['only spaces', '    '],
    ['a replacement character', onTheWire(`Sao${chars(0xfffd)}Paulo`)]
  ];

  it.each(hostile)('stores no city for %s, and the sign-in still works', async (_label, value) => {
    const user = await makeUser('city-hostile');
    const entered = await login(user, { 'cf-ipcity': value });
    expect(await cityOf(entered.id)).toBeNull();
    expect(await statusWith(entered.cookie)).toBe(200);
  });

  it('reads the bytes the edge puts on a real connection: UTF-8 is a name, 10 000 characters and a control byte are none, and the sign-in works', async () => {
    const real = await buildTestApp();
    extraApps.push(real);
    const user = await makeUser('city-socket', real);
    await real.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = real.app.server.address() as AddressInfo;

    // The request is written byte by byte: an HTTP client would encode the header its own way, and the edge sends UTF-8. The socket is
    // not half-closed after the write, because the server drops such a connection before it answers; `connection: close` ends it.
    const signIn = (city: Buffer | undefined) => new Promise<{ status: number; sessionCookies: number }>((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ email: user.email, password: user.password }));
      const head = Buffer.from(`POST /auth/login HTTP/1.1\r\nhost: 127.0.0.1\r\norigin: ${TEST_APP_PUBLIC_URL}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n`, 'latin1');
      const header = city === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from('cf-ipcity: ', 'latin1'), city, Buffer.from('\r\n', 'latin1')]);
      const socket = connect({ host: '127.0.0.1', port }, () => socket.write(Buffer.concat([head, header, Buffer.from('\r\n', 'latin1'), body])));
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('latin1');
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), sessionCookies: (text.match(/^set-cookie: ageniza\.session_token=/gim) ?? []).length });
      });
      socket.on('error', reject);
    });
    const cities = async (): Promise<(string | null)[]> =>
      (await owner.knex('auth.session').where({ userId: user.id }).orderBy('createdAt', 'asc').select<{ city: string | null }[]>('city')).map((row) => row.city);

    expect(await signIn(Buffer.from('Brasília', 'utf8'))).toEqual({ status: 200, sessionCookies: 1 });
    expect(await signIn(Buffer.from('São Paulo', 'utf8'))).toEqual({ status: 200, sessionCookies: 1 });
    expect(await signIn(Buffer.from('a'.repeat(10_000)))).toEqual({ status: 200, sessionCookies: 1 });
    expect(await signIn(Buffer.from('x'.repeat(80)))).toEqual({ status: 200, sessionCookies: 1 });
    // The server's own parser may refuse a control byte (400) or let it through; either way no city is kept for it.
    const control = await signIn(Buffer.from(`Sao${chars(0x1b)}[2JPaulo`, 'latin1'));
    expect([200, 400]).toContain(control.status);

    const stored = await cities();
    expect(stored.slice(0, 4)).toEqual(['Brasília', 'São Paulo', null, 'x'.repeat(80)]);
    expect(stored.slice(4).every((city) => city === null)).toBe(true);
  }, 60_000);

  it('does not change with the renewal of the session, which is the one write the application role may still make', async () => {
    const user = await makeUser('city-renewal');
    const aging = await seed(user.id, { createdAfter: 0, updatedAfter: -2 * 86_400, expiresIn: 5 * 86_400, city: 'Santos' });
    const before = (await rowOf(aging.id)) as { updatedAt: Date; expiresAt: Date };

    const response = await list(aging.cookie, { 'cf-ipcity': 'Manaus' });

    expect(response.statusCode).toBe(200);
    const after = (await rowOf(aging.id)) as { updatedAt: Date; expiresAt: Date; city: string | null };
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
    expect(after.city).toBe('Santos');
    expect((response.json() as { sessions: Listed[] }).sessions[0]).toMatchObject({ city: 'Santos', current: true });
  });

  it('is the city of the Google sign-in too', async () => {
    let google: FakeGoogle | undefined;
    let withGoogle: TestApp | undefined;
    const email = uniqueTestEmail('city-google');
    try {
      google = installFakeGoogle();
      withGoogle = await buildTestApp({ config: { google: TEST_GOOGLE } });
      const result = await signInWithGoogle(withGoogle.app, google, { sub: `sub-${randomUUID()}`, email, name: 'Pessoa do Google' }, { callbackHeaders: { 'cf-ipcity': onTheWire('Curitiba') } });
      expect(result.location).toBe(`${TEST_APP_PUBLIC_URL}/entrar/google`);

      const rows = await owner.knex('auth.session').join('auth.user', 'auth.user.id', 'auth.session.userId').where('auth.user.email', email).select<{ city: string | null }[]>('auth.session.city');
      expect(rows).toEqual([{ city: 'Curitiba' }]);
    } finally {
      google?.restore();
      await owner.knex('legal_acceptances').whereIn('user_id', owner.knex('auth.user').where({ email }).select('id')).delete();
      await owner.knex('auth.user').where({ email }).delete();
      await withGoogle?.close();
    }
  }, 60_000);
});

describe('the account an invitation created', () => {
  const accept = async (headers: Record<string, string>) => {
    const agencyId = randomUUID();
    createdAgencyIds.push(agencyId);
    await owner.knex('agencies').insert({ id: agencyId, name: `Sessions ${agencyId.slice(0, 8)}`, owner_user_id: null, status: 'active' });
    const invitation = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
    const email = uniqueTestEmail('sessions-invite');
    await owner.knex('invitations').insert({ agency_id: agencyId, purpose: 'agency_activation', email, token_hash: invitation.tokenHash, expires_at: invitation.expiresAt });

    const response = await app.app.inject({
      method: 'POST', url: `/invitations/${invitation.token}/accept-new-account`, headers: { ...origin, ...headers }, remoteAddress: nextAddress(),
      payload: { name: 'Pessoa Nova', password: 'a correct horse battery staple', acceptTerms: true }
    });
    expect(response.statusCode).toBe(201);
    const created = await owner.knex('auth.user').where({ email }).first<{ id: string }>('id');
    if (created === undefined) throw new Error('The account was not created.');
    createdUserIds.push(created.id);
    return { userId: created.id, cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') };
  };

  it('opens none of the three routes until the e-mail is confirmed, ends nothing meanwhile, and then lists the single session of the acceptance', async () => {
    const { userId, cookie } = await accept({ 'cf-ipcity': onTheWire('Campinas'), 'user-agent': CHROME_WINDOWS });
    const [only] = await idsOf(userId);
    expect(only).toBeDefined();

    for (const response of [await list(cookie), await revoke(cookie, randomUUID()), await revokeOthers(cookie)]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'EMAIL_NOT_CONFIRMED' } });
    }
    expect(await idsOf(userId)).toEqual([only]);
    expect(await cityOf(only as string)).toBe('Campinas');

    await owner.knex('auth.user').where({ id: userId }).update({ emailVerified: true });

    const shown = await listed(cookie);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: only, current: true, city: 'Campinas', browser: 'Chrome', os: 'Windows' });
    expect((await revokeOthers(cookie)).json()).toEqual({ revoked: 0 });
    expect((await revoke(cookie, only as string)).statusCode).toBe(409);
    expect(await idsOf(userId)).toEqual([only]);
  });
});

// The guard answers the rule of the credential (issue #719) by throwing when it cannot read it, never by "no": a failure turned into
// "this session is not older than the change" would let a session made before a password change through. The database of this file is
// its own, and the grant is given back whatever the assertions say.
describe('the guard when the credential cannot be read', () => {
  it('lets nothing through, the session older than the change of the password included, and carries on once it can be read again', async () => {
    const user = await makeUser('guard-unreadable');
    const raced = await seed(user.id, { createdAfter: 0 });
    await changePassword(user.id);
    const current = await seed(user.id, { createdAfter: 2 });

    const get = async (url: string, cookie: string): Promise<number> => (await app.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode;
    const routes = ['/auth/session', '/auth/sessions', '/me/contexts'];
    const canRead = async (): Promise<boolean> =>
      (await owner.knex.raw<{ rows: { allowed: boolean }[] }>(`select has_table_privilege('ageniza_app', 'auth.account', 'select') as allowed`)).rows[0]?.allowed === true;

    expect(await canRead()).toBe(true);
    for (const route of routes) expect(await get(route, current.cookie), route).toBe(200);

    await owner.knex.raw('revoke select on auth.account from ageniza_app');
    try {
      expect(await canRead()).toBe(false);
      for (const cookie of [current.cookie, raced.cookie]) {
        for (const route of routes) expect([401, 500], `${route} with ${cookie === current.cookie ? 'the current session' : 'the old session'}`).toContain(await get(route, cookie));
      }
    } finally {
      await owner.knex.raw('grant select on auth.account to ageniza_app');
    }

    expect(await canRead()).toBe(true);
    for (const route of routes) expect(await get(route, current.cookie), route).toBe(200);
    // The old session was still there, and the rule refuses it again as soon as it can be read.
    expect(await get('/auth/session', raced.cookie)).toBe(401);
  });
});
