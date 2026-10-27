import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  cleanupOwnedAgencyContext,
  createFakeEmailSender,
  grantOwnedAgencyContext,
  insertTestUser,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  TEST_AUTH_SECRET,
  uniqueTestEmail,
  type FakeEmailSender,
  type TestApp
} from './test-support/harness.js';
import { installFakeGoogle, signInWithGoogle, TEST_GOOGLE, type FakeGoogle, type FakeGoogleIdentity } from './test-support/fake-google.js';

// Issue #707, decision 2026-10-26 on Google: what the sign-in accepts, who it signs in as, what it takes over, and what it
// never says. Google is simulated at `fetch` (the token endpoint and the certificates of the id token) and answers like the
// real one, so the PKCE, the client secret, the redirect URI and the signature are all checked by someone other than the code.
const origin = { origin: TEST_APP_PUBLIC_URL };
const password = 'a google test password long enough';
const FAILURE = `${TEST_APP_PUBLIC_URL}/entrar?erro=google`;
const LANDING = `${TEST_APP_PUBLIC_URL}/entrar/google`;
const createdEmails: string[] = [];
const createdAgencies: string[] = [];
let app: TestApp;
let google: FakeGoogle;
let sender: FakeEmailSender;

const newEmail = (label: string): string => {
  const email = uniqueTestEmail(label);
  createdEmails.push(email);
  return email;
};

const identity = (email: string, overrides: Partial<FakeGoogleIdentity> = {}): FakeGoogleIdentity => {
  return { sub: `sub-${randomUUID()}`, email, name: 'Pessoa do Google', ...overrides };
};

beforeAll(async () => {
  google = installFakeGoogle();
  sender = createFakeEmailSender();
  app = await buildTestApp({ config: { google: TEST_GOOGLE }, sender });
});

afterEach(async () => {
  const agencies = createdAgencies.splice(0);
  if (agencies.length > 0) {
    await queryAsOwner('delete from public.agency_memberships where agency_id = any($1::uuid[])', [agencies]);
    await queryAsOwner('delete from public.role_permissions where role_id in (select id from public.roles where agency_id = any($1::uuid[]))', [agencies]);
    await queryAsOwner('delete from public.roles where agency_id = any($1::uuid[])', [agencies]);
    await queryAsOwner('delete from public.client_memberships where client_id in (select id from public.clients where agency_id = any($1::uuid[]))', [agencies]);
    await queryAsOwner('delete from public.clients where agency_id = any($1::uuid[])', [agencies]);
  }
  for (const agencyId of agencies) await cleanupOwnedAgencyContext(agencyId);
  const emails = createdEmails.splice(0);
  if (emails.length === 0) return;
  // `legal_acceptances` is proof of consent: the application role cannot delete it, so the owner cleans up.
  await queryAsOwner('delete from public.legal_acceptances where user_id in (select id from auth."user" where email = any($1::text[]))', [emails]);
  await queryAsOwner('delete from auth."user" where email = any($1::text[])', [emails]);
});

afterAll(async () => {
  google.restore();
  await app.close();
});

interface UserRow { id: string; emailVerified: boolean; passwordChangedAt: Date | null; image: string | null; name: string }
const userRow = async (email: string): Promise<UserRow | undefined> =>
  (await queryAsOwner<UserRow>('select id, "emailVerified", "passwordChangedAt", image, name from auth."user" where email = $1', [email]))[0];
const accountsOf = (userId: string) =>
  queryAsOwner<{ providerId: string; accountId: string; accessToken: string | null; refreshToken: string | null; idToken: string | null; password: string | null }>(
    'select "providerId", "accountId", "accessToken", "refreshToken", "idToken", password from auth.account where "userId" = $1 order by "providerId"', [userId]
  );
const sessionCount = async (userId: string): Promise<number> =>
  (await queryAsOwner('select 1 from auth.session where "userId" = $1', [userId])).length;
const acceptancesOf = (userId: string) =>
  queryAsOwner<{ document: string; revoked_at: Date | null }>('select document, revoked_at from public.legal_acceptances where user_id = $1 order by document, accepted_at', [userId]);

const cookieOf = (response: { readonly cookies: ReadonlyArray<{ readonly name: string; readonly value: string }> }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
/** The cookie Better Auth accepts: the token and the base64 HMAC-SHA256 of it under the secret, URL-encoded. A bare token is never read. */
const signedSessionCookie = (token: string): string =>
  `ageniza.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', TEST_AUTH_SECRET).update(token).digest('base64')}`)}`;
const getAs = (cookie: string, url: string) => app.app.inject({ method: 'GET', url, headers: { cookie } });
const passwordLogin = (email: string, candidate = password) =>
  app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, remoteAddress: '127.0.0.9', payload: { email, password: candidate } });

/** An account that signed up with e-mail and password and never confirmed: the one Google can take over. */
const signUpUnconfirmed = async (email: string): Promise<string> => {
  const response = await app.app.inject({
    method: 'POST', url: '/auth/sign-up', headers: origin, remoteAddress: '127.0.0.8',
    payload: { name: 'Quem se Cadastrou', email, password, acceptTerms: true }
  });
  expect(response.statusCode).toBe(202);
  await app.emailService.drain();
  const row = await userRow(email);
  if (row === undefined) throw new Error('The sign-up did not create the account.');
  expect(row.emailVerified).toBe(false);
  return row.id;
};

/** The raw token of the last message of a kind that went to the address (the database holds only its hash). */
const tokenSentTo = (email: string, path: string): string => {
  const message = [...sender.sent].reverse().find((sent) => sent.to === email && sent.text.includes(path));
  const match = /token=([^\s"&<]+)/.exec(message?.text ?? '');
  if (match?.[1] === undefined) throw new Error(`No ${path} link was sent to the address.`);
  return decodeURIComponent(match[1]);
};

const acceptBoth = async (cookie: string) => {
  for (const document of ['terms', 'privacy']) {
    const accepted = await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document } });
    expect(accepted.statusCode).toBe(200);
  }
};

/** Signs a brand new Google account in and accepts both documents, the way a person reaches the product. */
const newGoogleAccount = async (label: string, options: { accept?: boolean; remoteAddress?: string } = {}) => {
  const email = newEmail(label);
  const who = identity(email);
  const result = await signInWithGoogle(app.app, google, who, options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress });
  expect(result.location).toBe(LANDING);
  if (options.accept !== false) await acceptBoth(result.cookie);
  const row = await userRow(email);
  if (row === undefined) throw new Error('The Google sign-in did not create the account.');
  return { email, who, cookie: result.cookie, userId: row.id };
};

describe('the provider flag and the routes without credentials', () => {
  it('says whether Google is on with a flag and nothing else', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/auth/providers' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ google: true });
    expect(response.body).not.toContain(TEST_GOOGLE.clientSecret);
  });

  it('is off without the variables: the flag is false and both routes answer 404', async () => {
    const off = await buildTestApp();
    try {
      expect((await off.app.inject({ method: 'GET', url: '/auth/providers' })).json()).toEqual({ google: false });
      const start = await off.app.inject({ method: 'GET', url: '/auth/google/start' });
      const callback = await off.app.inject({ method: 'GET', url: '/auth/callback/google?code=x&state=y' });
      expect(start.statusCode).toBe(404);
      expect(callback.statusCode).toBe(404);
      expect(start.headers.location).toBeUndefined();
      expect(start.cookies).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('refuses an intent it does not know', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/auth/google/start?intent=admin' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('the authorization request (rule 7)', () => {
  it('asks for openid, email and profile and nothing else, with the state, a PKCE challenge and a nonce', async () => {
    const start = await app.app.inject({ method: 'GET', url: '/auth/google/start' });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    expect(location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    const params = google.parseAuthorization(location);

    expect([...(params.get('scope') ?? '').split(' ')].sort()).toEqual(['email', 'openid', 'profile']);
    expect(params.get('include_granted_scopes')).toBeNull();
    expect(params.get('access_type')).toBeNull();
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe(TEST_GOOGLE.clientId);
    expect(params.get('redirect_uri')).toBe(TEST_GOOGLE.callbackUrl);
    expect(params.get('state')?.length).toBeGreaterThanOrEqual(16);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')?.length).toBeGreaterThanOrEqual(43);
    expect(params.get('nonce')?.length).toBeGreaterThanOrEqual(32);
    expect(params.get('prompt')).toBeNull();
    // The secret is the server's: it is not in the address the browser is sent to, nor anywhere in the response.
    expect(location).not.toContain(TEST_GOOGLE.clientSecret);
    expect(start.body).not.toContain(TEST_GOOGLE.clientSecret);
    expect(start.headers['cache-control']).toContain('no-store');
  });

  it('uses a nonce and a state of its own for every attempt', async () => {
    const first = google.parseAuthorization(String((await app.app.inject({ method: 'GET', url: '/auth/google/start' })).headers.location));
    const second = google.parseAuthorization(String((await app.app.inject({ method: 'GET', url: '/auth/google/start' })).headers.location));
    expect(first.get('nonce')).not.toBe(second.get('nonce'));
    expect(first.get('state')).not.toBe(second.get('state'));
    expect(first.get('code_challenge')).not.toBe(second.get('code_challenge'));
  });

  it('sends the code verifier and the client secret to Google when it redeems the code, and stores no token', async () => {
    const before = google.tokenRequests.length;
    const { userId } = await newGoogleAccount('google-redeem', { accept: false });
    const request = google.tokenRequests[before];

    expect(request?.grantType).toBe('authorization_code');
    expect(request?.clientSecret).toBe(TEST_GOOGLE.clientSecret);
    expect(request?.redirectUri).toBe(TEST_GOOGLE.callbackUrl);
    expect(request?.codeVerifier?.length).toBeGreaterThanOrEqual(43);

    const [account] = await accountsOf(userId);
    expect(account).toMatchObject({ providerId: 'google', accessToken: null, refreshToken: null, idToken: null, password: null });
  });

  it('asks Google to authenticate the person again for a reauthentication, and lands on the screen that asked', async () => {
    const start = await app.app.inject({ method: 'GET', url: '/auth/google/start?intent=reauth' });
    expect(google.parseAuthorization(String(start.headers.location)).get('prompt')).toBe('login');

    const { cookie } = await newGoogleAccount('google-reauth-landing', { accept: false });
    const back = await signInWithGoogle(app.app, google, identity(newEmail('google-reauth-landing-2')), { intent: 'reauth', cookie });
    expect(back.location).toBe(`${LANDING}?intent=reauth`);
  });
});

describe('the callback refuses without saying why', () => {
  const noSession = async (email: string) => expect(await userRow(email)).toBeUndefined();

  it('refuses a state it did not issue, a missing state and a missing code, and creates nothing', async () => {
    const email = newEmail('google-state');
    for (const query of [
      (issued: { code: string; state: string }) => ({ code: issued.code, state: `${issued.state}x` }),
      (issued: { code: string; state: string }) => ({ code: issued.code, state: undefined }),
      (issued: { code: string; state: string }) => ({ code: undefined, state: issued.state })
    ]) {
      const result = await signInWithGoogle(app.app, google, identity(email), { query });
      expect(result.callback.statusCode).toBe(302);
      expect(result.location).toBe(FAILURE);
      expect(result.cookie).not.toContain('session_token');
    }
    await noSession(email);
  });

  it('refuses a callback that comes back to a browser that did not start the flow', async () => {
    const email = newEmail('google-other-browser');
    const start = await app.app.inject({ method: 'GET', url: '/auth/google/start' });
    const issued = google.authorize(String(start.headers.location), identity(email));
    const callback = await app.app.inject({ method: 'GET', url: `/auth/callback/google?code=${issued.code}&state=${issued.state}` });
    expect(callback.headers.location).toBe(FAILURE);
    expect(callback.cookies.some((cookie) => cookie.name.includes('session_token'))).toBe(false);
    await noSession(email);
  });

  it('refuses when Google reports an error, such as the person declining', async () => {
    const email = newEmail('google-declined');
    const result = await signInWithGoogle(app.app, google, identity(email), { query: (issued) => ({ error: 'access_denied', state: issued.state }) });
    expect(result.location).toBe(FAILURE);
    await noSession(email);
  });

  it('refuses an id token that is not Google\'s: another key, another client, another issuer, expired', async () => {
    const email = newEmail('google-bad-token');
    for (const overrides of [{ signWithOtherKey: true }, { audience: 'someone-else.apps.googleusercontent.com' }, { issuer: 'https://evil.example' }, { expiresInSeconds: -60 }]) {
      const result = await signInWithGoogle(app.app, google, identity(email), { overrides });
      expect(result.location).toBe(FAILURE);
      expect(result.cookie).not.toContain('session_token');
    }
    await noSession(email);
  });

  it('refuses an id token that does not carry the nonce of this very flow', async () => {
    const email = newEmail('google-nonce');
    for (const nonce of ['a-nonce-another-flow-issued', null]) {
      const result = await signInWithGoogle(app.app, google, identity(email), { overrides: { nonce } });
      expect(result.location).toBe(FAILURE);
      expect(result.cookie).not.toContain('session_token');
    }
    await noSession(email);
  });

  it('redeems a code once: Google refuses it the second time, and so does the sign-in', async () => {
    const email = newEmail('google-replay');
    const who = identity(email);
    const first = await signInWithGoogle(app.app, google, who);
    expect(first.location).toBe(LANDING);

    // The same code and state come back from another place; Google has already spent the code.
    const start = await app.app.inject({ method: 'GET', url: '/auth/google/start' });
    const issued = google.authorize(String(start.headers.location), who);
    const cookie = cookieOf(start);
    const ok = await app.app.inject({ method: 'GET', url: `/auth/callback/google?code=${issued.code}&state=${issued.state}`, headers: { cookie } });
    expect(ok.headers.location).toBe(LANDING);
    const replay = await app.app.inject({ method: 'GET', url: `/auth/callback/google?code=${issued.code}&state=${issued.state}`, headers: { cookie } });
    expect(replay.headers.location).toBe(FAILURE);
  });
});

describe('only an address Google verified (rule 1)', () => {
  it('refuses email_verified false, and creates nothing', async () => {
    const email = newEmail('google-unverified');
    const result = await signInWithGoogle(app.app, google, identity(email, { emailVerified: false }));
    expect(result.location).toBe(FAILURE);
    expect(result.cookie).not.toContain('session_token');
    expect(await userRow(email)).toBeUndefined();
  });

  it('refuses a value that is not the boolean true, which a broken issuer could send', async () => {
    const email = newEmail('google-unverified-string');
    for (const emailVerified of ['true', 1, 'yes']) {
      const result = await signInWithGoogle(app.app, google, identity(email, { emailVerified }));
      expect(result.location).toBe(FAILURE);
    }
    expect(await userRow(email)).toBeUndefined();
  });

  it('neither links nor takes over the account that holds the address when Google did not verify it', async () => {
    const confirmed = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-unverified-confirmed' });
    createdEmails.push(confirmed.email);
    const unconfirmedEmail = newEmail('google-unverified-unconfirmed');
    const unconfirmedId = await signUpUnconfirmed(unconfirmedEmail);

    for (const email of [confirmed.email, unconfirmedEmail]) {
      const result = await signInWithGoogle(app.app, google, identity(email, { emailVerified: false }));
      expect(result.location).toBe(FAILURE);
    }

    expect((await accountsOf(confirmed.id)).map((account) => account.providerId)).toEqual(['credential']);
    const untouched = await userRow(unconfirmedEmail);
    expect(untouched?.emailVerified).toBe(false);
    expect(untouched?.passwordChangedAt).toBeNull();
    expect((await accountsOf(unconfirmedId)).map((account) => account.providerId)).toEqual(['credential']);
    expect((await acceptancesOf(unconfirmedId)).every((row) => row.revoked_at === null)).toBe(true);
  });
});

describe('no account yet: the Google creates a confirmed one (rule 3)', () => {
  it('creates it confirmed, with the name Google gave, no password, no photo and no acceptance', async () => {
    const email = newEmail('google-created');
    const who = identity(email, { name: 'Maria do Google' });
    const result = await signInWithGoogle(app.app, google, who);

    expect(result.location).toBe(LANDING);
    expect(result.callback.cookies.some((cookie) => cookie.name.endsWith('session_token'))).toBe(true);
    const row = await userRow(email);
    expect(row).toMatchObject({ emailVerified: true, name: 'Maria do Google', image: null, passwordChangedAt: null });
    expect((await accountsOf(row!.id)).map(({ providerId, accountId }) => ({ providerId, accountId }))).toEqual([{ providerId: 'google', accountId: who.sub }]);
    expect(await acceptancesOf(row!.id)).toEqual([]);

    const session = await getAs(result.cookie, '/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json().user.email).toBe(email);
  });

  it('asks for the Terms and the Privacy Policy before any use: no context, no agency, until both are accepted', async () => {
    const { cookie, userId } = await newGoogleAccount('google-gate', { accept: false });
    const agencyId = await grantOwnedAgencyContext(userId);
    createdAgencies.push(agencyId);

    const status = await getAs(cookie, '/me/legal-acceptances');
    expect(status.statusCode).toBe(200);
    expect(status.json().required).toBe(true);
    expect(status.json().documents.map((entry: { pending: boolean }) => entry.pending)).toEqual([true, true]);
    // The agency it owns is not listed, and the decision says there is none.
    const contexts = await getAs(cookie, '/me/contexts');
    expect(contexts.json()).toMatchObject({ contexts: [], canCreateAgency: false });
    expect((await getAs(cookie, '/me/contexts/resolve')).json().decision).toBe('none');
    const created = await app.app.inject({ method: 'POST', url: '/agencies', headers: { ...origin, cookie }, payload: { name: 'Agência sem aceite' } });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe('TERMS_NOT_ACCEPTED');

    await acceptBoth(cookie);
    const after = await getAs(cookie, '/me/legal-acceptances');
    expect(after.json().required).toBe(false);
    expect((await getAs(cookie, '/me/contexts')).json().contexts).toHaveLength(1);
  });

  it('blocks only after the first document: accepting one of the two still leaves it required', async () => {
    const { cookie } = await newGoogleAccount('google-gate-half', { accept: false });
    await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document: 'terms' } });
    expect((await getAs(cookie, '/me/legal-acceptances')).json().required).toBe(true);
    await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document: 'privacy' } });
    expect((await getAs(cookie, '/me/legal-acceptances')).json().required).toBe(false);
  });

  it('does not ask a password account for it: only an account with Google is blocked', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-gate-password' });
    createdEmails.push(person.email);
    const login = await passwordLogin(person.email, person.password);
    expect((await getAs(cookieOf(login), '/me/legal-acceptances')).json().required).toBe(false);
  });
});

describe('a confirmed account gains Google as a second way in (rule 4)', () => {
  it('links the same account, keeps the password and the sessions, and leaves the acceptances alone', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-link' });
    createdEmails.push(person.email);
    const loggedIn = await passwordLogin(person.email, person.password);
    const oldCookie = cookieOf(loggedIn);
    await queryAsOwner(`insert into public.legal_acceptances (user_id, document, version) values ($1, 'terms', '2026-01-01'), ($1, 'privacy', '2026-01-01')`, [person.id]);

    const who = identity(person.email);
    const result = await signInWithGoogle(app.app, google, who);

    expect(result.location).toBe(LANDING);
    expect((await getAs(result.cookie, '/auth/session')).json().user.id).toBe(person.id);
    expect((await accountsOf(person.id)).map((account) => account.providerId)).toEqual(['credential', 'google']);
    expect((await passwordLogin(person.email, person.password)).statusCode).toBe(200);
    expect((await getAs(oldCookie, '/auth/session')).statusCode).toBe(200);
    expect((await userRow(person.email))?.passwordChangedAt).toBeNull();
    expect((await acceptancesOf(person.id)).every((row) => row.revoked_at === null)).toBe(true);
    // It has accepted: Google does not ask again.
    expect((await getAs(result.cookie, '/me/legal-acceptances')).json().required).toBe(false);
  });

  it('enters by the subject on the next sign-in, to the very same account', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-again' });
    createdEmails.push(person.email);
    const who = identity(person.email);
    await signInWithGoogle(app.app, google, who);
    const again = await signInWithGoogle(app.app, google, who);
    expect(again.location).toBe(LANDING);
    expect((await getAs(again.cookie, '/auth/session')).json().user.id).toBe(person.id);
    expect((await accountsOf(person.id)).filter((account) => account.providerId === 'google')).toHaveLength(1);
  });
});

describe('the account is the subject, not the address (rule 2)', () => {
  it('refuses a sign-in whose address is no longer the one of the account linked to that subject', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-sub-moved' });
    createdEmails.push(person.email);
    const other = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-sub-moved-other' });
    createdEmails.push(other.email);
    const who = identity(person.email);
    await signInWithGoogle(app.app, google, who);

    // Google now reports the subject with the address of someone else's account.
    const result = await signInWithGoogle(app.app, google, { ...who, email: other.email });

    expect(result.location).toBe(FAILURE);
    expect(result.cookie).not.toContain('session_token');
    expect((await accountsOf(other.id)).map((account) => account.providerId)).toEqual(['credential']);
    // And with an address nobody has: refused as well, no new account for the subject.
    const brandNew = newEmail('google-sub-moved-new');
    expect((await signInWithGoogle(app.app, google, { ...who, email: brandNew })).location).toBe(FAILURE);
    expect(await userRow(brandNew)).toBeUndefined();
  });

  it('refuses another Google identity for an address whose account already has one', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-two-subjects' });
    createdEmails.push(person.email);
    await signInWithGoogle(app.app, google, identity(person.email));

    const result = await signInWithGoogle(app.app, google, identity(person.email));

    expect(result.location).toBe(FAILURE);
    expect((await accountsOf(person.id)).filter((account) => account.providerId === 'google')).toHaveLength(1);
  });

  it('cannot hold the same subject on two accounts, nor two Google identities on one account', async () => {
    const first = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-unique-a' });
    const second = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-unique-b' });
    createdEmails.push(first.email, second.email);
    const sub = `sub-${randomUUID()}`;
    const link = (userId: string, accountId: string) => queryAsOwner(
      'insert into auth.account (id, "accountId", "providerId", "userId", "updatedAt") values ($1, $2, \'google\', $3, now())', [randomUUID(), accountId, userId]
    );
    await link(first.id, sub);
    await expect(link(second.id, sub)).rejects.toMatchObject({ code: '23505' });
    await expect(link(first.id, `sub-${randomUUID()}`)).rejects.toMatchObject({ code: '23505' });
  });

  it('lets only Google and the password be an account at all: no other provider links, with a verified address or not', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-other-provider' });
    createdEmails.push(person.email);
    const { internalAdapter } = await app.auth.$context;
    const created = await internalAdapter.createAccount({ userId: person.id, providerId: 'github', accountId: 'octocat' }).catch(() => null);
    expect(created ?? null).toBeNull();
    expect((await accountsOf(person.id)).map((account) => account.providerId)).toEqual(['credential']);
  });
});

describe('Google takes over an unconfirmed account (rule 5)', () => {
  it('kills the password, the sessions, the pending links, the pending e-mail change and the acceptance, in one go', async () => {
    const email = newEmail('google-takeover');
    const userId = await signUpUnconfirmed(email);
    const survivor = randomUUID();
    await queryAsOwner(
      `insert into auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
      [survivor, `token-${survivor}`, userId]
    );
    await queryAsOwner(`insert into auth.verification (id, identifier, value, "expiresAt") values ($1, $2, $3, now() + interval '1 hour')`, [randomUUID(), `reset-${survivor}`, userId]);
    await queryAsOwner(
      `insert into public.email_change_requests (user_id, old_email, new_email, credential_fingerprint) values ($1, $2, $3, 'x')`,
      [userId, email, newEmail('google-takeover-wanted')]
    );
    expect((await queryAsOwner('select 1 from public.email_confirmations where user_id = $1 and consumed_at is null', [userId])).length).toBe(1);
    expect((await acceptancesOf(userId)).length).toBe(2);
    expect((await userRow(email))?.name).toBe('Quem se Cadastrou');

    const result = await signInWithGoogle(app.app, google, identity(email));

    expect(result.location).toBe(LANDING);
    expect((await userRow(email))?.emailVerified).toBe(true);
    // The name the earlier holder typed is gone: the account carries the name of the Google profile.
    expect((await userRow(email))?.name).toBe('Pessoa do Google');
    // The password is gone, and the old sign-in no longer works.
    expect((await accountsOf(userId)).map((account) => account.providerId)).toEqual(['google']);
    expect((await passwordLogin(email)).statusCode).toBe(401);
    // Every earlier session is gone; the only one is the one Google just made.
    expect(await queryAsOwner('select 1 from auth.session where id = $1', [survivor])).toEqual([]);
    expect(await sessionCount(userId)).toBe(1);
    // Signed the way the server reads it, the cookie of the old session is refused now because the session is gone: the account is
    // confirmed by this point, so nothing else could refuse it (the test below shows that the same kind of cookie is accepted).
    expect((await getAs(signedSessionCookie(`token-${survivor}`), '/auth/session')).statusCode).toBe(401);
    // The pending links die: reset links and confirmations.
    expect(await queryAsOwner(`select 1 from auth.verification where value = $1 and identifier like 'reset-%'`, [userId])).toEqual([]);
    expect(await queryAsOwner('select 1 from public.email_confirmations where user_id = $1 and consumed_at is null', [userId])).toEqual([]);
    // The pending change of e-mail is closed, without a link.
    expect(await queryAsOwner<{ status: string; token_hash: string | null }>('select status, token_hash from public.email_change_requests where user_id = $1', [userId]))
      .toEqual([{ status: 'superseded', token_hash: null }]);
    // The acceptance whoever signed up recorded is revoked (the row stays), and asked for again.
    const acceptances = await acceptancesOf(userId);
    expect(acceptances).toHaveLength(2);
    expect(acceptances.every((row) => row.revoked_at !== null)).toBe(true);
    expect((await getAs(result.cookie, '/me/legal-acceptances')).json()).toMatchObject({ required: true });
    // It was dated, so a session that predates the takeover is refused even if its row survived.
    expect((await userRow(email))?.passwordChangedAt).toBeInstanceOf(Date);
    expect((await queryAsOwner('select 1 from audit.events where action = $1 and actor_user_id = $2', ['auth.google_takeover', userId])).length).toBe(1);
  });

  it('does not let the confirmation link the earlier holder had confirm anything any more', async () => {
    const email = newEmail('google-takeover-link');
    const userId = await signUpUnconfirmed(email);
    // The link of the sign-up is in the e-mail the earlier holder of the form received.
    const token = tokenSentTo(email, '/email/verificar');
    await signInWithGoogle(app.app, google, identity(email));
    const verify = await app.app.inject({
      method: 'POST', url: '/auth/email/verify', headers: origin, remoteAddress: '127.0.0.7',
      payload: { token, password }
    });
    expect(verify.statusCode).toBe(400);
    // It did not give the earlier holder a password on the account Google now owns.
    expect(await queryAsOwner('select 1 from auth.account where "userId" = $1 and "providerId" = $2', [userId, 'credential'])).toEqual([]);
  });

  it('asks for the acceptance again and writes a new row when the same version is accepted', async () => {
    const email = newEmail('google-takeover-accept');
    const userId = await signUpUnconfirmed(email);
    const result = await signInWithGoogle(app.app, google, identity(email));
    await acceptBoth(result.cookie);

    const rows = await acceptancesOf(userId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(2);
    expect((await getAs(result.cookie, '/me/legal-acceptances')).json().required).toBe(false);
  });

  it('keeps the links the account already had, and gives the contexts back once the acceptance is renewed', async () => {
    const email = newEmail('google-takeover-links');
    const userId = await signUpUnconfirmed(email);
    const agencyId = await grantOwnedAgencyContext(userId);
    createdAgencies.push(agencyId);

    const result = await signInWithGoogle(app.app, google, identity(email));
    expect((await getAs(result.cookie, '/me/contexts')).json().contexts).toEqual([]);

    await acceptBoth(result.cookie);
    expect((await getAs(result.cookie, '/me/contexts')).json().contexts).toHaveLength(1);
  });

  it('reads the signed cookie of a live session and refuses the same token unsigned, so the refusal above is about the session', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-signed-cookie' });
    createdEmails.push(person.email);
    const sessionId = randomUUID();
    await queryAsOwner(
      `insert into auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
      [sessionId, `token-${sessionId}`, person.id]
    );

    expect((await getAs(signedSessionCookie(`token-${sessionId}`), '/auth/session')).statusCode).toBe(200);
    expect((await getAs(`ageniza.session_token=token-${sessionId}`, '/auth/session')).statusCode).toBe(401);
  });

  it.each([['an empty name', ''], ['a name of blanks', '   ']])('names the account by the part of the address before the @ when the Google profile has %s', async (_label, profileName) => {
    const email = newEmail('google-takeover-noname');
    await signUpUnconfirmed(email);

    await signInWithGoogle(app.app, google, identity(email, { name: profileName }));

    expect((await userRow(email))?.name).toBe(email.split('@')[0]);
  });

  it('never takes a confirmed account over: its password and acceptances are the person\'s', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-no-takeover' });
    createdEmails.push(person.email);
    await queryAsOwner(`insert into public.legal_acceptances (user_id, document, version) values ($1, 'terms', '2026-01-01')`, [person.id]);
    await signInWithGoogle(app.app, google, identity(person.email));
    expect((await passwordLogin(person.email, person.password)).statusCode).toBe(200);
    expect((await acceptancesOf(person.id)).every((row) => row.revoked_at === null)).toBe(true);
    // Nor does it rename it: the name is the one the person chose.
    expect((await userRow(person.email))?.name).toBe('Integration Test User');
  });
});

describe('the takeover is all or nothing', () => {
  it('leaves the account exactly as it was when its last step fails, and the sign-in is refused', async () => {
    const email = newEmail('google-atomic');
    const userId = await signUpUnconfirmed(email);
    const survivor = randomUUID();
    await queryAsOwner(
      `insert into auth.session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
      [survivor, `token-${survivor}`, userId]
    );
    // The audit row is the takeover's last write: failing it after everything else was written must undo all of it.
    const name = `fail_takeover_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await queryAsOwner(`create function audit.${name}() returns trigger language plpgsql as $$ begin if new.action = 'auth.google_takeover' then raise exception 'injected failure'; end if; return new; end $$`);
    await queryAsOwner(`create trigger ${name} before insert on audit.events for each row execute function audit.${name}()`);
    try {
      const result = await signInWithGoogle(app.app, google, identity(email));
      expect(result.location).toBe(FAILURE);
      expect(result.cookie).not.toContain('session_token');
    } finally {
      await queryAsOwner(`drop trigger if exists ${name} on audit.events`);
      await queryAsOwner(`drop function if exists audit.${name}()`);
    }

    expect(await userRow(email)).toMatchObject({ emailVerified: false, passwordChangedAt: null });
    expect((await accountsOf(userId)).map((account) => account.providerId)).toEqual(['credential']);
    expect(await queryAsOwner('select 1 from auth.session where id = $1', [survivor])).toHaveLength(1);
    expect(await queryAsOwner('select 1 from public.email_confirmations where user_id = $1 and consumed_at is null', [userId])).toHaveLength(1);
    expect((await acceptancesOf(userId)).every((row) => row.revoked_at === null)).toBe(true);
    expect(await queryAsOwner(`select 1 from audit.events where action = 'auth.google_takeover' and actor_user_id = $1`, [userId])).toEqual([]);
  });
});

describe('the session predating a credential change is not a session (issue #719 mechanism)', () => {
  it('refuses the session created before passwordChangedAt, and accepts the one created after', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-changed-at' });
    createdEmails.push(person.email);
    const cookie = cookieOf(await passwordLogin(person.email, person.password));
    expect((await getAs(cookie, '/auth/session')).statusCode).toBe(200);

    // The session is a minute old; the credential changed 30 seconds ago, after it and before the next one.
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '1 minute' where "userId" = $1`, [person.id]);
    await queryAsOwner(`update auth."user" set "passwordChangedAt" = now() - interval '30 seconds' where id = $1`, [person.id]);
    expect((await getAs(cookie, '/auth/session')).statusCode).toBe(401);
    expect(await sessionCount(person.id)).toBe(0);

    const fresh = cookieOf(await passwordLogin(person.email, person.password));
    expect((await getAs(fresh, '/auth/session')).statusCode).toBe(200);
  });

  it('refuses a session created in the very instant of the change', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-changed-at-equal' });
    createdEmails.push(person.email);
    const cookie = cookieOf(await passwordLogin(person.email, person.password));
    const [{ createdAt }] = await queryAsOwner<{ createdAt: Date }>('select "createdAt" from auth.session where "userId" = $1', [person.id]);
    await queryAsOwner('update auth."user" set "passwordChangedAt" = $2 where id = $1', [person.id, createdAt]);
    expect((await getAs(cookie, '/auth/session')).statusCode).toBe(401);
  });
});

describe('an account with only Google (rule 6)', () => {
  const requestEmailChange = (cookie: string, payload: Record<string, unknown>) =>
    app.app.inject({ method: 'POST', url: '/me/email-change', headers: { ...origin, cookie }, remoteAddress: '127.0.0.6', payload });

  it('changes the e-mail on the Google sign-in of the last 5 minutes, without a password', async () => {
    const { cookie, userId, who } = await newGoogleAccount('google-only-change');
    const response = await requestEmailChange(cookie, { newEmail: newEmail('google-only-wanted') });
    await app.emailService.drain();

    expect(response.statusCode).toBe(202);
    const [request] = await queryAsOwner<{ status: string; credential_fingerprint: string }>(
      'select status, credential_fingerprint from public.email_change_requests where user_id = $1', [userId]
    );
    expect(request?.status).toBe('pending');
    // The fingerprint is the Google subject's, in the place of the hash of a password.
    expect(request?.credential_fingerprint).toBe(createHash('sha256').update(who.sub).digest('hex'));
  });

  it('asks to confirm with Google again once the sign-in is older than 5 minutes, and creates no request', async () => {
    const { cookie, userId } = await newGoogleAccount('google-only-old');
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '6 minutes' where "userId" = $1`, [userId]);

    const response = await requestEmailChange(cookie, { newEmail: newEmail('google-only-old-wanted') });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('REAUTH_REQUIRED');
    expect(await queryAsOwner('select 1 from public.email_change_requests where user_id = $1', [userId])).toEqual([]);
  });

  it('counts the window from the sign-in: just inside is accepted, just outside is not', async () => {
    const inside = await newGoogleAccount('google-only-inside');
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '4 minutes 30 seconds' where "userId" = $1`, [inside.userId]);
    expect((await requestEmailChange(inside.cookie, { newEmail: newEmail('google-only-inside-wanted') })).statusCode).toBe(202);

    const outside = await newGoogleAccount('google-only-outside');
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '5 minutes 30 seconds' where "userId" = $1`, [outside.userId]);
    expect((await requestEmailChange(outside.cookie, { newEmail: newEmail('google-only-outside-wanted') })).statusCode).toBe(403);
  });

  it('is not rescued by a password it does not have: any value is refused as before', async () => {
    const { cookie, userId } = await newGoogleAccount('google-only-password');
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '10 minutes' where "userId" = $1`, [userId]);
    const response = await requestEmailChange(cookie, { newEmail: newEmail('google-only-password-wanted'), currentPassword: password });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('REAUTH_REQUIRED');
  });

  it('still asks the account that has a password for it, with or without Google', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'google-both' });
    createdEmails.push(person.email);
    await signInWithGoogle(app.app, google, identity(person.email));
    const cookie = cookieOf(await passwordLogin(person.email, person.password));

    const without = await requestEmailChange(cookie, { newEmail: newEmail('google-both-wanted') });
    // Leaving the password out is the 400 it always was for an account that has one; Google does not replace it.
    expect(without.statusCode).toBe(400);
    expect(without.json().error.code).toBe('VALIDATION_ERROR');
    const wrong = await requestEmailChange(cookie, { newEmail: newEmail('google-both-wanted'), currentPassword: 'not the password' });
    expect(wrong.json().error.code).toBe('INVALID_PASSWORD');
    const right = await requestEmailChange(cookie, { newEmail: newEmail('google-both-wanted'), currentPassword: person.password });
    expect(right.statusCode).toBe(202);
  });

  it('reauthenticates by Google: the new sign-in is the proof, and a stale session becomes a fresh one', async () => {
    const { cookie, userId, who } = await newGoogleAccount('google-only-reauth');
    await queryAsOwner(`update auth.session set "createdAt" = now() - interval '10 minutes' where "userId" = $1`, [userId]);
    expect((await requestEmailChange(cookie, { newEmail: newEmail('google-only-reauth-wanted') })).json().error.code).toBe('REAUTH_REQUIRED');

    const again = await signInWithGoogle(app.app, google, who, { intent: 'reauth', cookie });

    expect(again.location).toBe(`${LANDING}?intent=reauth`);
    expect((await requestEmailChange(again.cookie, { newEmail: newEmail('google-only-reauth-wanted') })).statusCode).toBe(202);
  });

  it('creates a password through "Esqueci a senha", keeps Google, and the request made under Google stops being valid', async () => {
    const { cookie, userId, email } = await newGoogleAccount('google-only-forgot');
    await requestEmailChange(cookie, { newEmail: newEmail('google-only-forgot-wanted') });
    const fingerprintOf = async () => (await queryAsOwner<{ fingerprint: string }>('select app_private.credential_fingerprint($1) as fingerprint', [userId]))[0]?.fingerprint;
    const [request] = await queryAsOwner<{ credential_fingerprint: string }>('select credential_fingerprint from public.email_change_requests where user_id = $1', [userId]);
    expect(await fingerprintOf()).toBe(request?.credential_fingerprint);

    const forgot = await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, remoteAddress: '127.0.0.5', payload: { email } });
    expect(forgot.statusCode).toBe(202);
    await app.emailService.drain();
    const newPassword = 'a password the google person chose';
    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin, payload: { token: tokenSentTo(email, '/senha/redefinir'), newPassword }
    });
    expect(reset.statusCode).toBe(204);

    expect((await accountsOf(userId)).map((account) => account.providerId)).toEqual(['credential', 'google']);
    expect((await passwordLogin(email, newPassword)).statusCode).toBe(200);
    // Now the credential is the password: the fingerprint moved, and the request made under the subject can no longer be confirmed.
    expect(await fingerprintOf()).not.toBe(request?.credential_fingerprint);
    // And from here the account is asked for the password, as any other.
    const login = cookieOf(await passwordLogin(email, newPassword));
    const wrong = await requestEmailChange(login, { newEmail: newEmail('google-only-forgot-again'), currentPassword: 'not the password at all' });
    expect(wrong.json().error.code).toBe('INVALID_PASSWORD');
    expect((await requestEmailChange(login, { newEmail: newEmail('google-only-forgot-again'), currentPassword: newPassword })).statusCode).toBe(202);
  });
});

describe('the Google flow reveals nothing about who has a password account (rule 8)', () => {
  /** What a caller can compare between two addresses: everything but what is unique to a request. */
  const comparable = (result: Awaited<ReturnType<typeof signInWithGoogle>>) => {
    const headers = { ...result.callback.headers };
    delete headers.date;
    delete headers['x-request-id'];
    delete headers['x-correlation-id'];
    delete headers['set-cookie'];
    return { status: result.callback.statusCode, location: result.location, body: result.callback.body, headers };
  };

  it('answers the same refusal for an address with a password account and for one with none', async () => {
    const confirmed = await insertTestUser(app.pool, app.auth, { emailLabel: 'oracle-confirmed' });
    createdEmails.push(confirmed.email);
    const unconfirmed = newEmail('oracle-unconfirmed');
    await signUpUnconfirmed(unconfirmed);
    const nobody = newEmail('oracle-nobody');

    const answers = [];
    for (const email of [confirmed.email, unconfirmed, nobody]) {
      answers.push(comparable(await signInWithGoogle(app.app, google, identity(email, { emailVerified: false }))));
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(answers[0]?.location).toBe(FAILURE);
  });

  it('answers the same refusal whatever made it: no address, no subject and no token detail in the redirect', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'oracle-reason' });
    createdEmails.push(person.email);
    const who = identity(person.email);
    await signInWithGoogle(app.app, google, who);

    const unverified = await signInWithGoogle(app.app, google, identity(newEmail('oracle-reason-a'), { emailVerified: false }));
    const wrongNonce = await signInWithGoogle(app.app, google, identity(newEmail('oracle-reason-b')), { overrides: { nonce: 'wrong-nonce' } });
    const moved = await signInWithGoogle(app.app, google, { ...who, email: newEmail('oracle-reason-c') });
    const secondSubject = await signInWithGoogle(app.app, google, identity(person.email));
    const declined = await signInWithGoogle(app.app, google, identity(person.email), { query: (issued) => ({ error: 'access_denied', state: issued.state }) });

    for (const refused of [unverified, wrongNonce, moved, secondSubject, declined]) {
      expect(comparable(refused)).toEqual(comparable(unverified));
      expect(refused.location).toBe(FAILURE);
    }
  });

  it('does not change the answer of the password login or of the sign-up for the same address', async () => {
    const email = newEmail('oracle-password-side');
    await signUpUnconfirmed(email);
    const before = await passwordLogin(email);
    await signInWithGoogle(app.app, google, identity(email, { emailVerified: false }));
    const after = await passwordLogin(email);
    expect(after.statusCode).toBe(before.statusCode);
    expect(after.json().error).toEqual(before.json().error);
  });
});

// The acceptance is asked for before the first use on every road in, not only on the screen: the routes of an agency and of the
// portal answer 403 TERMS_NOT_ACCEPTED while it is pending (decision 2026-10-26, items 2 and 4), and what the person needs to
// accept stays reachable. The cases are the two accounts the block exists for, each with a link to an agency and to a client.
interface Linked { readonly agencyId: string; readonly clientId: string }

const linkedTo = async (userId: string): Promise<Linked> => {
  const agencyId = await grantOwnedAgencyContext(userId);
  createdAgencies.push(agencyId);
  const clientId = randomUUID();
  await queryAsOwner(`insert into public.clients (id, agency_id, name, status) values ($1, $2, 'Cliente do vínculo', 'active')`, [clientId, agencyId]);
  await queryAsOwner(`insert into public.client_memberships (client_id, user_id, status) values ($1, $2, 'active')`, [clientId, userId]);
  return { agencyId, clientId };
};

interface Probe { readonly label: string; readonly method: 'GET' | 'POST'; readonly url: string; readonly payload?: object; readonly allowed: number }
const agencyProbes = (linked: Linked): Probe[] => [
  { label: 'GET /agencies/:agencyId/me', method: 'GET', url: `/agencies/${linked.agencyId}/me`, allowed: 200 },
  { label: 'GET /agencies/:agencyId/clients', method: 'GET', url: `/agencies/${linked.agencyId}/clients`, allowed: 200 },
  { label: 'POST /agencies/:agencyId/clients', method: 'POST', url: `/agencies/${linked.agencyId}/clients`, payload: { name: 'Cliente sem aceite' }, allowed: 201 }
];
const portalProbes = (linked: Linked): Probe[] => [
  { label: 'GET /clients/:clientId', method: 'GET', url: `/clients/${linked.clientId}`, allowed: 200 },
  { label: 'POST /clients/:clientId/onboarding/seen', method: 'POST', url: `/clients/${linked.clientId}/onboarding/seen`, allowed: 204 }
];
const callAs = (cookie: string, probe: Probe) => app.app.inject({
  method: probe.method, url: probe.url, headers: { ...origin, cookie }, ...(probe.payload === undefined ? {} : { payload: probe.payload })
});
const expectRefusedForTerms = async (cookie: string, probes: readonly Probe[]): Promise<void> => {
  for (const probe of probes) {
    const response = await callAs(cookie, probe);
    expect(response.statusCode, probe.label).toBe(403);
    expect(response.json().error.code, probe.label).toBe('TERMS_NOT_ACCEPTED');
  }
};
const expectAllowed = async (cookie: string, probes: readonly Probe[]): Promise<void> => {
  for (const probe of probes) expect((await callAs(cookie, probe)).statusCode, probe.label).toBe(probe.allowed);
};

describe('the acceptance blocks the routes of an agency and of the portal, not only the screen (issue #707)', () => {
  const accounts: ReadonlyArray<readonly [string, () => Promise<{ cookie: string; userId: string }>]> = [
    ['a Google account that has accepted nothing', () => newGoogleAccount('block-new', { accept: false })],
    ['an invitation account Google took over, with both acceptances revoked', async () => {
      const email = newEmail('block-takeover');
      const userId = await signUpUnconfirmed(email);
      return { cookie: (await signInWithGoogle(app.app, google, identity(email))).cookie, userId };
    }]
  ];

  describe.each(accounts)('%s', (_label, makeAccount) => {
    it('is refused by every agency route, and the write leaves nothing behind', async () => {
      const { cookie, userId } = await makeAccount();
      const linked = await linkedTo(userId);

      await expectRefusedForTerms(cookie, agencyProbes(linked));

      expect(await queryAsOwner(`select 1 from public.clients where agency_id = $1 and name = 'Cliente sem aceite'`, [linked.agencyId])).toEqual([]);
    });

    it('is refused by every portal route, and the write leaves nothing behind', async () => {
      const { cookie, userId } = await makeAccount();
      const linked = await linkedTo(userId);

      await expectRefusedForTerms(cookie, portalProbes(linked));

      expect(await queryAsOwner(`select 1 from public.client_memberships where client_id = $1 and onboarding_seen_at is not null`, [linked.clientId])).toEqual([]);
    });

    it('is let in by the very same routes once both documents are accepted', async () => {
      const { cookie, userId } = await makeAccount();
      const linked = await linkedTo(userId);
      await expectRefusedForTerms(cookie, [...agencyProbes(linked), ...portalProbes(linked)]);

      await acceptBoth(cookie);

      await expectAllowed(cookie, [...agencyProbes(linked), ...portalProbes(linked)]);
      expect((await queryAsOwner(`select 1 from public.clients where agency_id = $1 and name = 'Cliente sem aceite'`, [linked.agencyId])).length).toBe(1);
    });

    it('stays refused after accepting only one of the two documents', async () => {
      const { cookie, userId } = await makeAccount();
      const linked = await linkedTo(userId);

      const first = await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document: 'terms' } });
      expect(first.statusCode).toBe(200);
      await expectRefusedForTerms(cookie, [agencyProbes(linked)[0]!, portalProbes(linked)[0]!]);

      const second = await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document: 'privacy' } });
      expect(second.statusCode).toBe(200);
      await expectAllowed(cookie, [agencyProbes(linked)[0]!, portalProbes(linked)[0]!]);
    });

    it('keeps free what the person needs in order to accept: the session, the documents, the profile and the sign-out', async () => {
      const { cookie } = await makeAccount();

      expect((await getAs(cookie, '/auth/session')).statusCode).toBe(200);
      const status = await getAs(cookie, '/me/legal-acceptances');
      expect(status.statusCode).toBe(200);
      expect(status.json().required).toBe(true);
      const profile = await app.app.inject({ method: 'PATCH', url: '/me/profile', headers: { ...origin, cookie }, payload: { name: 'Nome para aceitar' } });
      expect(profile.statusCode).toBe(200);
      const accepted = await app.app.inject({ method: 'POST', url: '/me/legal-acceptances', headers: { ...origin, cookie }, payload: { document: 'terms' } });
      expect(accepted.statusCode).toBe(200);
      expect((await app.app.inject({ method: 'POST', url: '/auth/logout', headers: { ...origin, cookie } })).statusCode).toBe(204);
    });
  });

  it('does not refuse an old confirmed account that has no acceptance row and no Google: only an account with Google is blocked', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'block-legacy' });
    createdEmails.push(person.email);
    expect(await acceptancesOf(person.id)).toEqual([]);
    const login = await passwordLogin(person.email, person.password);
    expect(login.statusCode).toBe(200);
    const linked = await linkedTo(person.id);

    await expectAllowed(cookieOf(login), [...agencyProbes(linked), ...portalProbes(linked)]);
  });

  it('refuses that same old account from the moment it gains Google, until it accepts: the side effect the decision accepts', async () => {
    const person = await insertTestUser(app.pool, app.auth, { emailLabel: 'block-legacy-google' });
    createdEmails.push(person.email);
    const linked = await linkedTo(person.id);

    const result = await signInWithGoogle(app.app, google, identity(person.email));
    expect(result.location).toBe(LANDING);
    expect(await acceptancesOf(person.id)).toEqual([]);
    await expectRefusedForTerms(result.cookie, [agencyProbes(linked)[0]!, portalProbes(linked)[0]!]);

    await acceptBoth(result.cookie);
    await expectAllowed(result.cookie, [agencyProbes(linked)[0]!, portalProbes(linked)[0]!]);
  });

  it('holds for a collaborator whose role has the one permission the route needs, and lets exactly that route in once accepted', async () => {
    const owner = await insertTestUser(app.pool, app.auth, { emailLabel: 'block-role-owner' });
    createdEmails.push(owner.email);
    const agencyId = await grantOwnedAgencyContext(owner.id);
    createdAgencies.push(agencyId);
    const roleId = randomUUID();
    await queryAsOwner(`insert into public.roles (id, agency_id, key, name, is_system) values ($1, $2, 'only-clients-read', 'only-clients-read', false)`, [roleId, agencyId]);
    await queryAsOwner(`insert into public.role_permissions (role_id, permission_key) values ($1, 'cliente.visualizar')`, [roleId]);
    const { cookie, userId } = await newGoogleAccount('block-role', { accept: false });
    await queryAsOwner(`insert into public.agency_memberships (agency_id, user_id, role_id, status) values ($1, $2, $3, 'active')`, [agencyId, userId, roleId]);

    await expectRefusedForTerms(cookie, [{ label: 'GET clients', method: 'GET', url: `/agencies/${agencyId}/clients`, allowed: 200 }]);
    await acceptBoth(cookie);

    expect((await getAs(cookie, `/agencies/${agencyId}/clients`)).statusCode).toBe(200);
    // The permission is still the route's: the role has no right to register a client, with or without the acceptance.
    expect((await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients`, headers: { ...origin, cookie }, payload: { name: 'Sem permissão' } })).statusCode).toBe(403);
  });

  it('answers 404 before 403 for an agency or a client the person is not linked to, so the block tells nothing about other people', async () => {
    const { cookie } = await newGoogleAccount('block-stranger', { accept: false });
    const stranger = await insertTestUser(app.pool, app.auth, { emailLabel: 'block-stranger-owner' });
    createdEmails.push(stranger.email);
    const elsewhere = await linkedTo(stranger.id);

    expect((await getAs(cookie, `/agencies/${elsewhere.agencyId}/me`)).statusCode).toBe(404);
    expect((await getAs(cookie, `/clients/${elsewhere.clientId}`)).statusCode).toBe(404);
  });
});

// The name Google gives goes through the schema of `PATCH /me/profile`, for a new account and for the takeover: what the profile
// would answer 400 for does not get in by the Google door (review of #733). The account then carries the part of the address
// before the @, like a profile with no name.
describe('the name of the Google profile is held to the same rule as the name in the profile', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['a right-to-left override (U+202E)', 'Ana ‮admin'],
    ['a zero-width space (U+200B)', 'Ana​Silva'],
    ['a line break', 'Ana\nSilva'],
    ['a carriage return and a line feed', 'Ana\r\nSilva'],
    ['121 characters, one over the limit', 'a'.repeat(121)]
  ];

  it.each(refused)('names a new account by the part of the address when the profile name has %s', async (_label, profileName) => {
    const email = newEmail('google-name-new');

    await signInWithGoogle(app.app, google, identity(email, { name: profileName }));

    expect((await userRow(email))?.name).toBe(email.split('@')[0]);
  });

  it.each(refused)('names a taken-over account by the part of the address when the profile name has %s', async (_label, profileName) => {
    const email = newEmail('google-name-takeover');
    await signUpUnconfirmed(email);

    await signInWithGoogle(app.app, google, identity(email, { name: profileName }));

    expect((await userRow(email))?.name).toBe(email.split('@')[0]);
  });

  it.each([['a new account', false], ['a taken-over account', true]])('keeps the name of exactly 120 characters, trimmed, for %s', async (_label, takeOver) => {
    const email = newEmail('google-name-limit');
    if (takeOver) await signUpUnconfirmed(email);
    const exact = 'b'.repeat(120);

    await signInWithGoogle(app.app, google, identity(email, { name: `  ${exact}  ` }));

    expect((await userRow(email))?.name).toBe(exact);
  });
});

describe('limits', () => {
  it('answers 429 without rate-limit headers once an address starts and returns too often', async () => {
    const limited = await buildTestApp({ config: { google: TEST_GOOGLE } });
    try {
      let last;
      for (let attempt = 0; attempt < 61; attempt += 1) {
        last = await limited.app.inject({ method: 'GET', url: '/auth/google/start', remoteAddress: '10.9.9.9' });
      }
      expect(last?.statusCode).toBe(429);
      expect(last?.headers['x-ratelimit-limit']).toBeUndefined();
      expect(last?.headers['retry-after']).toBeUndefined();
    } finally {
      await limited.close();
    }
  });
});
