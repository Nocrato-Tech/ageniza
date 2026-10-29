import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  uniqueTestEmail,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';
import { installFakeGoogle, signInWithGoogle, TEST_GOOGLE, type FakeGoogle } from './test-support/fake-google.js';

// The native app (Expo) signs in and writes with no `Origin` of its own: it names itself in `expo-origin` and carries the
// session as a `Cookie` header it stored itself. Everything past the origin check is the code of the browser, so these tests
// prove the door (listed or not) and that the rules that end a session end the app's too.
const APP = 'ageniza://';
const APP_REDIRECT = 'ageniza://auth/google';
const appHeaders = { 'expo-origin': APP };
const FAILURE = `${TEST_APP_PUBLIC_URL}/entrar?erro=google`;

let listed: TestApp;
let unlisted: TestApp;
let narrower: TestApp;
let google: FakeGoogle;
const owner = ownerClient();
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  google = installFakeGoogle();
  listed = await buildTestApp({ config: { google: TEST_GOOGLE, mobileAppOrigins: [APP, 'ageniza-extra://'] } });
  unlisted = await buildTestApp({ config: { google: TEST_GOOGLE } });
  narrower = await buildTestApp({ config: { google: TEST_GOOGLE, mobileAppOrigins: [APP] } });
});

afterEach(async () => {
  const agencyIds = createdAgencyIds.splice(0);
  const userIds = createdUserIds.splice(0);
  await queryAsOwner('delete from public.agency_memberships where agency_id = any($1::uuid[]) or user_id = any($2::uuid[])', [agencyIds, userIds]);
  await queryAsOwner('delete from audit.events where agency_id = any($1::uuid[])', [agencyIds]);
  await queryAsOwner('update public.agencies set owner_user_id = null where id = any($1::uuid[])', [agencyIds]);
  await queryAsOwner('delete from public.agencies where id = any($1::uuid[])', [agencyIds]);
  await queryAsOwner('delete from auth."user" where id = any($1::uuid[])', [userIds]);
  const emails = createdEmails.splice(0);
  await queryAsOwner('delete from public.legal_acceptances where user_id in (select id from auth."user" where email = any($1::text[]))', [emails]);
  await queryAsOwner('delete from auth."user" where email = any($1::text[])', [emails]);
});

afterAll(async () => {
  google.restore();
  await Promise.all([listed.close(), unlisted.close(), narrower.close()]);
});

const makeUser = async (label: string, options: { emailVerified?: boolean } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(listed.pool, listed.auth, { emailLabel: label, ...options });
  createdUserIds.push(user.id);
  return user;
};

/** The app's login: no `Origin`, only what the Expo client sends. */
const appLogin = (target: TestApp, user: Pick<TestUserFixture, 'email' | 'password'>, headers: Record<string, string> = appHeaders) =>
  target.app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: user.email, password: user.password } });

const cookieOf = (response: { readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }> }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginAsApp = async (user: TestUserFixture): Promise<string> => {
  const response = await appLogin(listed, user);
  expect(response.statusCode).toBe(200);
  return cookieOf(response);
};

const sessionStatus = async (cookie: string): Promise<number> =>
  (await listed.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })).statusCode;

const sessionCount = async (userId: string): Promise<number> =>
  (await queryAsOwner('select 1 from auth.session where "userId" = $1', [userId])).length;

describe('the origin of the native app (MOBILE_APP_ORIGINS)', () => {
  it('signs in and writes with `expo-origin` and the stored cookie, with no Origin, when its scheme is listed', async () => {
    const user = await makeUser('app-login');
    const login = await appLogin(listed, user);
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login);
    expect(cookie).toContain('ageniza.session_token=');

    expect(await sessionStatus(cookie)).toBe(200);
    const logout = await listed.app.inject({ method: 'POST', url: '/auth/logout', headers: { ...appHeaders, cookie } });
    expect(logout.statusCode).toBe(204);
    expect(await sessionStatus(cookie)).toBe(401);
  });

  it('also accepts the scheme as the Origin header, and Expo\'s triple-slash form', async () => {
    const user = await makeUser('app-origin-header');
    expect((await appLogin(listed, user, { origin: APP })).statusCode).toBe(200);
    expect((await appLogin(listed, user, { 'expo-origin': 'ageniza:///' })).statusCode).toBe(200);
  });

  it('refuses the app\'s origin when no scheme is listed: the same CSRF_REJECTED as today', async () => {
    const user = await makeUser('app-unlisted');
    for (const headers of [appHeaders, { origin: APP }] as Array<Record<string, string>>) {
      const login = await appLogin(unlisted, user, headers);
      expect(login.statusCode).toBe(403);
      expect(login.json().error.code).toBe('CSRF_REJECTED');
    }
    expect(await sessionCount(user.id)).toBe(0);
  });

  it('refuses a scheme that is not on the list, as expo-origin and as Origin', async () => {
    const user = await makeUser('app-other-scheme');
    for (const headers of [{ 'expo-origin': 'evil://' }, { origin: 'evil://' }, { 'expo-origin': 'ageniza://host' }, { 'expo-origin': 'https://evil.test' }] as Array<Record<string, string>>) {
      const login = await appLogin(listed, user, headers);
      expect(login.statusCode, JSON.stringify(headers)).toBe(403);
      expect(login.json().error.code).toBe('CSRF_REJECTED');
    }
    expect(await sessionCount(user.id)).toBe(0);
  });

  it('does not let expo-origin stand in for a web Origin that is wrong', async () => {
    const user = await makeUser('app-origin-wins');
    const login = await appLogin(listed, user, { origin: 'https://evil.test', ...appHeaders });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('CSRF_REJECTED');
  });

  it('answers an account that never confirmed its e-mail exactly as the browser does', async () => {
    const user = await makeUser('app-unconfirmed', { emailVerified: false });
    const web = await appLogin(listed, user, { origin: TEST_APP_PUBLIC_URL });
    const native = await appLogin(listed, user);
    expect(web.statusCode).toBe(401);
    expect(native.statusCode).toBe(web.statusCode);
    expect(native.json().error).toEqual(web.json().error);
    expect(native.cookies).toEqual([]);
  });
});

describe('the session of the app ends like any other', () => {
  it('logout-all from one device ends the session of every device, the app\'s included', async () => {
    const user = await makeUser('app-logout-all');
    const phone = await loginAsApp(user);
    const tablet = await loginAsApp(user);
    expect(await sessionCount(user.id)).toBe(2);

    expect((await listed.app.inject({ method: 'POST', url: '/auth/logout-all', headers: { ...appHeaders, cookie: phone } })).statusCode).toBe(204);

    expect(await sessionCount(user.id)).toBe(0);
    expect(await sessionStatus(phone)).toBe(401);
    expect(await sessionStatus(tablet)).toBe(401);
  });

  it('removing a collaborator ends their app session on the very next request', async () => {
    const admin = (await owner.knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id')).id as string;
    const boss = await makeUser('app-boss');
    const person = await makeUser('app-removed');
    const agencyId = randomUUID();
    createdAgencyIds.push(agencyId);
    await owner.knex('agencies').insert({ id: agencyId, name: `App removal ${agencyId}`, owner_user_id: boss.id, status: 'active' });
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: boss.id, role_id: admin, status: 'active' });
    const [membership] = await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: person.id, role_id: admin, status: 'active' }).returning('id');

    const bossCookie = await loginAsApp(boss);
    const personCookie = await loginAsApp(person);
    const collaborators = `/agencies/${agencyId}/collaborators`;
    expect((await listed.app.inject({ method: 'GET', url: collaborators, headers: { cookie: personCookie } })).statusCode).toBe(200);

    const removal = await listed.app.inject({ method: 'POST', url: `${collaborators}/${membership.id}/remove`, headers: { ...appHeaders, cookie: bossCookie } });
    expect(removal.statusCode).toBe(200);

    expect(await sessionCount(person.id)).toBe(0);
    expect((await listed.app.inject({ method: 'GET', url: collaborators, headers: { cookie: personCookie } })).statusCode).toBe(401);
    expect(await sessionStatus(personCookie)).toBe(401);
    expect(await sessionStatus(bossCookie)).toBe(200);
  });
});

describe('Google from the app', () => {
  const newGoogleEmail = (): string => {
    const email = uniqueTestEmail('app-google');
    createdEmails.push(email);
    return email;
  };
  const identity = (email: string, emailVerified?: unknown) => ({ sub: `sub-${randomUUID()}`, email, name: 'Pessoa do App', ...(emailVerified === undefined ? {} : { emailVerified }) });

  it('returns to the deep link with the session, and that session is the account\'s', async () => {
    const email = newGoogleEmail();
    const result = await signInWithGoogle(listed.app, google, identity(email), { appRedirect: APP_REDIRECT });

    expect(result.callback.statusCode).toBe(302);
    const back = new URL(result.location);
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(APP_REDIRECT);
    const setCookie = back.searchParams.get('cookie') ?? '';
    const token = /ageniza\.session_token=([^;]+)/.exec(setCookie)?.[1];
    expect(token).toBeDefined();
    const session = await listed.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: `ageniza.session_token=${token}` } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe(email);
  });

  it('keeps going to the web screen when the flow did not begin in the app', async () => {
    const result = await signInWithGoogle(listed.app, google, identity(newGoogleEmail()));
    expect(result.location).toBe(`${TEST_APP_PUBLIC_URL}/entrar/google`);
  });

  it('refuses a deep link of a scheme that is not listed, a web address, credentials and a fragment, before Google', async () => {
    let ip = 0;
    for (const appRedirect of ['evil://auth', 'https://evil.test/x', `${APP}u:p@host/x`, `${APP_REDIRECT}#frag`, 'not a url', 'javascript:alert(1)']) {
      ip += 1;
      const start = await listed.app.inject({ method: 'GET', url: `/auth/google/start?appRedirect=${encodeURIComponent(appRedirect)}`, remoteAddress: `10.88.0.${ip}` });
      expect(start.statusCode, appRedirect).toBe(400);
      expect(start.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses any deep link while no scheme is listed', async () => {
    const start = await unlisted.app.inject({ method: 'GET', url: `/auth/google/start?appRedirect=${encodeURIComponent(APP_REDIRECT)}`, remoteAddress: '10.88.1.1' });
    expect(start.statusCode).toBe(400);
  });

  it('does not follow a deep link that is no longer on the list when Google comes back', async () => {
    const result = await signInWithGoogle(listed.app, google, identity(newGoogleEmail()), { appRedirect: 'ageniza-extra://auth', callbackApp: narrower.app });

    expect(result.location).toBe(FAILURE);
  });

  it('comes back to the deep link without a session and without saying why when Google refuses', async () => {
    const result = await signInWithGoogle(listed.app, google, identity(newGoogleEmail(), false), { appRedirect: APP_REDIRECT });

    expect(result.callback.statusCode).toBe(302);
    const back = new URL(result.location);
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(APP_REDIRECT);
    expect(back.search).toBe('?erro=google');
  });
});
