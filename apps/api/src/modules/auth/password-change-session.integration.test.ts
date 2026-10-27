import { Client } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { OutgoingEmail } from '@ageniza/email';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  OWNER_DATABASE_URL,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  uniqueTestEmail,
  type FakeEmailSender,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';

// Issue #719: a password change stamps `passwordChangedAt` in its own statement, and a login or an e-mail
// confirmation that checked the old password never leaves a session that outlives the reset.
const origin = { origin: TEST_APP_PUBLIC_URL };
const password = 'the password before the reset';
const newPassword = 'the password the reset chose';
const createdEmails: string[] = [];
const openApps: TestApp[] = [];
const cleanups: Array<() => Promise<void>> = [];
let addressCounter = 0;

const nextAddress = (): string => {
  addressCounter += 1;
  return `10.${19 + Math.floor(addressCounter / 65536)}.${Math.floor(addressCounter / 256) % 256}.${addressCounter % 256}`;
};

const openApp = async (): Promise<{ app: TestApp; sender: FakeEmailSender }> => {
  const sender = createFakeEmailSender();
  const app = await buildTestApp({ sender });
  openApps.push(app);
  return { app, sender };
};

const newEmail = (label: string): string => {
  const email = uniqueTestEmail(label);
  createdEmails.push(email);
  return email;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  const emails = createdEmails.splice(0);
  if (emails.length === 0) return;
  await queryAsOwner('delete from public.legal_acceptances where user_id in (select id from auth."user" where email = any($1::text[]))', [emails]);
  await queryAsOwner('delete from auth."user" where email = any($1::text[])', [emails]);
});

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const makeUser = async (app: TestApp, label: string): Promise<TestUserFixture> => {
  const email = newEmail(label);
  return insertTestUser(app.pool, app.auth, { email, password });
};

const cookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginAs = (app: TestApp, email: string, candidate = password) =>
  app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, remoteAddress: nextAddress(), payload: { email, password: candidate } });

const sessionStatus = async (app: TestApp, cookies: readonly { name: string; value: string }[]): Promise<number> =>
  (await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: cookieHeader(cookies) } })).statusCode;

const messagesTo = (sender: FakeEmailSender, email: string): OutgoingEmail[] => sender.sent.filter((message) => message.to === email);

const tokenIn = (sender: FakeEmailSender, email: string, marker: string, pattern: RegExp): string => {
  const match = pattern.exec(messagesTo(sender, email).find((message) => message.text.includes(marker))?.text ?? '');
  if (match?.[1] === undefined) throw new Error(`No ${marker} link for ${email}.`);
  return decodeURIComponent(match[1]);
};

const requestReset = async (app: TestApp, sender: FakeEmailSender, email: string): Promise<string> => {
  await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, remoteAddress: nextAddress(), payload: { email } });
  await app.emailService.drain();
  return tokenIn(sender, email, '/senha/redefinir', /token=([^\s&]+)/);
};

const reset = (app: TestApp, token: string) =>
  app.app.inject({ method: 'POST', url: '/auth/password/reset', headers: origin, remoteAddress: nextAddress(), payload: { token, newPassword } });

const signUp = async (app: TestApp, sender: FakeEmailSender, label: string): Promise<{ email: string; confirmationToken: string }> => {
  const email = newEmail(label);
  const response = await app.app.inject({
    method: 'POST', url: '/auth/sign-up', headers: origin, remoteAddress: nextAddress(),
    payload: { name: 'Pessoa Nova', email, password, acceptTerms: true }
  });
  expect(response.statusCode).toBe(202);
  await app.emailService.drain();
  return { email, confirmationToken: tokenIn(sender, email, '/email/verificar', /\/email\/verificar\?token=([^\s"&<]+)/) };
};

const verify = (app: TestApp, token: string, candidate = password) =>
  app.app.inject({ method: 'POST', url: '/auth/email/verify', headers: origin, remoteAddress: nextAddress(), payload: { token, password: candidate } });

/** The latest date the credential was replaced: the one on the user and the one on its credential, whichever is greater. */
const passwordChangedAt = async (email: string): Promise<Date | null> =>
  (await queryAsOwner<{ at: Date | null }>(
    `select greatest(person."passwordChangedAt", (select max(credential."passwordChangedAt") from auth.account credential where credential."userId" = person.id)) as at
     from auth."user" person where person.email = $1`,
    [email]
  ))[0]?.at ?? null;

const sessionCountOf = async (email: string): Promise<number> =>
  (await queryAsOwner('select 1 from auth.session where "userId" = (select id from auth."user" where email = $1)', [email])).length;

describe('the date of a password change (#719)', () => {
  it('a reset stamps passwordChangedAt at the instant of the change, and a login after it is a valid session', async () => {
    const { app, sender } = await openApp();
    const user = await makeUser(app, 'stamp-reset');
    expect(await passwordChangedAt(user.email)).toBeNull();
    const old = await loginAs(app, user.email);
    const token = await requestReset(app, sender, user.email);

    const before = Date.now();
    expect((await reset(app, token)).statusCode).toBe(204);
    const after = Date.now();

    const stamped = await passwordChangedAt(user.email);
    expect(stamped).not.toBeNull();
    expect(stamped?.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(stamped?.getTime()).toBeLessThanOrEqual(after + 2000);
    expect(await sessionStatus(app, old.cookies)).toBe(401);
    const fresh = await loginAs(app, user.email, newPassword);
    expect(fresh.statusCode).toBe(200);
    expect(await sessionStatus(app, fresh.cookies)).toBe(200);
  });

  it('the reset that takes an unconfirmed account over stamps the date too, and its first sessions are valid', async () => {
    const { app, sender } = await openApp();
    const { email, confirmationToken } = await signUp(app, sender, 'stamp-takeover');
    expect(await passwordChangedAt(email)).toBeNull();
    const resetToken = await requestReset(app, sender, email);

    expect((await reset(app, resetToken)).statusCode).toBe(204);

    expect(await passwordChangedAt(email)).not.toBeNull();
    expect((await verify(app, confirmationToken, newPassword)).statusCode).toBe(400);
    const fresh = await loginAs(app, email, newPassword);
    expect(fresh.statusCode).toBe(200);
    expect(await sessionStatus(app, fresh.cookies)).toBe(200);
  });

  it('the function that takes an unconfirmed account over stamps the date by itself, and a confirmed account is left alone', async () => {
    const { app, sender } = await openApp();
    const { email } = await signUp(app, sender, 'stamp-function');
    const confirmed = await makeUser(app, 'stamp-function-confirmed');
    const unconfirmedId = (await queryAsOwner<{ id: string }>('select id from auth."user" where email = $1', [email]))[0]?.id;

    const result = await queryAsOwner<{ taken: boolean }>('select app_private.confirm_email_by_password_reset($1::uuid) as taken', [unconfirmedId]);
    const untouched = await queryAsOwner<{ taken: boolean }>('select app_private.confirm_email_by_password_reset($1::uuid) as taken', [confirmed.id]);

    expect(result[0]?.taken).toBe(true);
    expect(await passwordChangedAt(email)).not.toBeNull();
    expect(untouched[0]?.taken).toBe(false);
    expect(await passwordChangedAt(confirmed.email)).toBeNull();
  });

  it('replacing the password in the database stamps the date, and rewriting the same hash or another column does not', async () => {
    const { app } = await openApp();
    const user = await makeUser(app, 'stamp-trigger');
    const hash = (await queryAsOwner<{ password: string }>('select password from auth.account where "userId" = $1', [user.id]))[0]?.password;

    await queryAsOwner('update auth.account set password = $2 where "userId" = $1', [user.id, hash]);
    await queryAsOwner('update auth.account set "updatedAt" = now() where "userId" = $1', [user.id]);
    expect(await passwordChangedAt(user.email)).toBeNull();

    await queryAsOwner('update auth.account set password = $2 where "userId" = $1', [user.id, `${hash ?? ''}x`]);
    expect(await passwordChangedAt(user.email)).not.toBeNull();
  });

  it('the guard refuses a session created at or before the date and accepts one created after it, to the millisecond', async () => {
    const { app } = await openApp();
    const user = await makeUser(app, 'guard-boundary');
    const cases = [
      { offsetMs: 0, status: 401 },
      { offsetMs: 1, status: 401 },
      { offsetMs: -1, status: 200 }
    ];
    for (const { offsetMs, status } of cases) {
      const login = await loginAs(app, user.email);
      await queryAsOwner(
        `update auth."user" set "passwordChangedAt" = (select "createdAt" from auth.session where "userId" = $1 order by "createdAt" desc limit 1) + ($2 || ' milliseconds')::interval where id = $1`,
        [user.id, String(offsetMs)]
      );

      expect(await sessionStatus(app, login.cookies), `offset ${offsetMs} ms`).toBe(status);
      await queryAsOwner('delete from auth.session where "userId" = $1', [user.id]);
    }
  });

  it('the guard reads the date of the credential as well, to the millisecond', async () => {
    const { app } = await openApp();
    const user = await makeUser(app, 'guard-boundary-credential');
    for (const { offsetMs, status } of [{ offsetMs: 0, status: 401 }, { offsetMs: 1, status: 401 }, { offsetMs: -1, status: 200 }]) {
      const login = await loginAs(app, user.email);
      await queryAsOwner(
        `update auth.account set "passwordChangedAt" = (select "createdAt" from auth.session where "userId" = $1 order by "createdAt" desc limit 1) + ($2 || ' milliseconds')::interval where "userId" = $1`,
        [user.id, String(offsetMs)]
      );

      expect(await sessionStatus(app, login.cookies), `offset ${offsetMs} ms`).toBe(status);
      await queryAsOwner('delete from auth.session where "userId" = $1', [user.id]);
    }
  });

  it('the application role cannot write either date, and still writes the other columns Better Auth writes', async () => {
    const { app } = await openApp();
    const user = await makeUser(app, 'grant-by-column');
    const asApp = async (statement: string): Promise<void> => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try { await client.query(statement, [user.id]); } finally { await client.end(); }
    };

    await expect(asApp(`update auth."user" set "passwordChangedAt" = null where id = $1`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`update auth.account set "passwordChangedAt" = null where "userId" = $1`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`update auth."user" set name = 'Renamed', "updatedAt" = now() where id = $1`)).resolves.toBeUndefined();
    await expect(asApp(`update auth.account set "updatedAt" = now() where "userId" = $1`)).resolves.toBeUndefined();
  });
});

interface ParkedInsert {
  release: () => Promise<void>;
  waitUntilParked: (request: Promise<{ statusCode: number; body: string }>) => Promise<void>;
}

let parkSequence = 0;

/**
 * Parks the insert of the next session of this account: the trigger waits for an advisory lock the test holds, so the
 * login (or confirmation) that checked the password sits exactly between checking it and writing its session.
 * `stampAfterParking` makes the row carry the instant it is finally written, like a session created after the reset.
 */
const parkSessionInsert = async (userId: string, stampAfterParking: boolean): Promise<ParkedInsert> => {
  parkSequence += 1;
  const key = 719_000 + parkSequence;
  const name = `test_park_session_${key}`;
  const holder = new Client({ connectionString: OWNER_DATABASE_URL });
  await holder.connect();
  await holder.query('select pg_advisory_lock($1)', [key]);
  await queryAsOwner(`create function public.${name}() returns trigger language plpgsql as $$ begin
    perform pg_advisory_lock(${key}); perform pg_advisory_unlock(${key});
    ${stampAfterParking ? 'new."createdAt" := clock_timestamp();' : ''}
    return new; end $$`);
  await queryAsOwner(`create trigger ${name} before insert on auth.session for each row when (new."userId" = '${userId}'::uuid) execute function public.${name}()`);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await holder.query('select pg_advisory_unlock($1)', [key]);
    await holder.end();
  };
  cleanups.push(async () => {
    await release();
    await queryAsOwner(`drop trigger if exists ${name} on auth.session`);
    await queryAsOwner(`drop function if exists public.${name}()`);
  });
  const waitUntilParked = async (request: Promise<{ statusCode: number; body: string }>): Promise<void> => {
    let settled: { statusCode: number; body: string } | undefined;
    void request.then((response) => { settled = response; }, () => undefined);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (settled) throw new Error(`The request ended before its session insert was parked: ${settled.statusCode} ${settled.body}`);
      const waiting = await queryAsOwner('select 1 from pg_locks where locktype = $1 and not granted and objid = $2', ['advisory', key]);
      if (waiting.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The session insert never reached the trigger.');
  };
  return { release, waitUntilParked };
};

describe('a login with the old password that races the reset (#719)', () => {
  for (const stampAfterParking of [false, true]) {
    const when = stampAfterParking ? 'the session row carries an instant after the reset' : 'the session row carries an instant before the reset';

    it(`leaves no valid session when ${when}`, async () => {
      const { app, sender } = await openApp();
      const user = await makeUser(app, `race-login-${stampAfterParking ? 'after' : 'before'}`);
      const parked = await parkSessionInsert(user.id, stampAfterParking);
      const token = await requestReset(app, sender, user.email);

      const login = loginAs(app, user.email);
      await parked.waitUntilParked(login);
      expect((await reset(app, token)).statusCode).toBe(204);
      await parked.release();
      const response = await login;

      expect(response.statusCode).toBe(401);
      expect(response.cookies.length).toBe(0);
      expect(await passwordChangedAt(user.email)).not.toBeNull();
      expect(await sessionCountOf(user.email)).toBe(0);
    }, 60_000);
  }

  it('leaves no valid session in any of 14 rounds of 8 parallel logins with the old password and a reset', async () => {
    const { app, sender } = await openApp();
    for (let round = 0; round < 14; round += 1) {
      const user = await makeUser(app, `race-login-${round}`);
      const token = await requestReset(app, sender, user.email);

      const [resetResponse, ...attempts] = await Promise.all([
        reset(app, token),
        ...Array.from({ length: 8 }, () => loginAs(app, user.email))
      ]);

      expect(resetResponse.statusCode).toBe(204);
      expect(await passwordChangedAt(user.email)).not.toBeNull();
      for (const attempt of attempts) {
        expect([200, 401]).toContain(attempt.statusCode);
        expect(await sessionStatus(app, attempt.cookies), `round ${round}`).toBe(401);
      }
      expect(await sessionCountOf(user.email)).toBe(0);
    }
  }, 240_000);
});

describe('POST /auth/email/verify with the old password that races the reset (#719)', () => {
  for (const stampAfterParking of [false, true]) {
    const when = stampAfterParking ? 'the session row carries an instant after the reset' : 'the session row carries an instant before the reset';

    it(`leaves no valid session when ${when}`, async () => {
      const { app, sender } = await openApp();
      const { email, confirmationToken } = await signUp(app, sender, `race-verify-${stampAfterParking ? 'after' : 'before'}`);
      const userId = (await queryAsOwner<{ id: string }>('select id from auth."user" where email = $1', [email]))[0]?.id ?? '';
      const parked = await parkSessionInsert(userId, stampAfterParking);
      const resetToken = await requestReset(app, sender, email);

      const confirmation = verify(app, confirmationToken);
      await parked.waitUntilParked(confirmation);
      expect((await reset(app, resetToken)).statusCode).toBe(204);
      await parked.release();
      const response = await confirmation;

      expect(response.statusCode).toBe(400);
      expect(response.cookies.length).toBe(0);
      expect(await passwordChangedAt(email)).not.toBeNull();
      expect(await sessionCountOf(email)).toBe(0);
    }, 60_000);
  }

  it('leaves no valid session in any of 10 rounds of 4 parallel confirmations with the old password and a reset', async () => {
    const { app, sender } = await openApp();
    for (let round = 0; round < 10; round += 1) {
      const { email, confirmationToken } = await signUp(app, sender, `race-verify-${round}`);
      const resetToken = await requestReset(app, sender, email);

      const [resetResponse, ...attempts] = await Promise.all([
        reset(app, resetToken),
        ...Array.from({ length: 4 }, () => verify(app, confirmationToken))
      ]);

      expect(resetResponse.statusCode).toBe(204);
      expect(await passwordChangedAt(email)).not.toBeNull();
      for (const attempt of attempts) {
        expect([200, 400]).toContain(attempt.statusCode);
        expect(await sessionStatus(app, attempt.cookies), `round ${round}`).toBe(401);
      }
      expect(await sessionCountOf(email)).toBe(0);
    }
  }, 240_000);
});

describe('the reset, the confirmation link and Google taking the account over, all at once (#719)', () => {
  it('never deadlocks, never answers 500 and leaves no valid session, in 12 rounds', async () => {
    const { app, sender } = await openApp();
    for (let round = 0; round < 12; round += 1) {
      const { email, confirmationToken } = await signUp(app, sender, `deadlock-${round}`);
      const userId = (await queryAsOwner<{ id: string }>('select id from auth."user" where email = $1', [email]))[0]?.id ?? '';
      const resetToken = await requestReset(app, sender, email);

      const [resetResponse, takeover, ...attempts] = await Promise.all([
        reset(app, resetToken),
        queryAsOwner('select app_private.google_takes_over_account($1, $2)', [userId, 'Google Person']).then(() => 'done', (error: unknown) => String(error)),
        ...Array.from({ length: 3 }, () => verify(app, confirmationToken))
      ]);

      expect(takeover, `round ${round}`).toBe('done');
      expect([204, 400], `round ${round}`).toContain(resetResponse.statusCode);
      for (const attempt of attempts) {
        expect([200, 400], `round ${round}`).toContain(attempt.statusCode);
        expect(await sessionStatus(app, attempt.cookies), `round ${round}`).toBe(401);
      }
      expect(await sessionCountOf(email)).toBe(0);
    }
  }, 240_000);
});
