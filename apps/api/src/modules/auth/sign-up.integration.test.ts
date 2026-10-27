import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { OutgoingEmail } from '@ageniza/email';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  uniqueTestEmail,
  type FakeEmailSender,
  type TestApp
} from './test-support/harness.js';
import { hashEmailConfirmationToken } from './email-verification.js';

// Issue #706, and finding A1 of the review of PR #720: the public sign-up, the confirmation link that
// asks for the password, the reset that confirms, and the answers that never tell a taken address apart.
const origin = { origin: TEST_APP_PUBLIC_URL };
const password = 'a sign-up password long enough';
const createdEmails: string[] = [];
const openApps: TestApp[] = [];

const openApp = async (sender: FakeEmailSender = createFakeEmailSender()): Promise<{ app: TestApp; sender: FakeEmailSender }> => {
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
  const emails = createdEmails.splice(0);
  if (emails.length === 0) return;
  // `legal_acceptances` is proof of consent: the application role cannot delete it, so the owner cleans up.
  await queryAsOwner('delete from public.legal_acceptances where user_id in (select id from auth."user" where email = any($1::text[]))', [emails]);
  await queryAsOwner('delete from auth."user" where email = any($1::text[])', [emails]);
});

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const signUp = (app: TestApp, email: string, remoteAddress = '127.0.0.1', requestId = 'sign-up-shared-request-id') =>
  app.app.inject({
    method: 'POST', url: '/auth/sign-up', headers: { ...origin, 'x-request-id': requestId }, remoteAddress,
    payload: { name: 'Pessoa Nova', email, password, acceptTerms: true }
  });

const verify = (app: TestApp, token: string, candidate = password, remoteAddress = '127.0.0.1') =>
  app.app.inject({
    method: 'POST', url: '/auth/email/verify', headers: { ...origin, 'x-request-id': 'verify-shared-request-id' }, remoteAddress,
    payload: { token, password: candidate }
  });

const resend = (app: TestApp, email: string, remoteAddress = '127.0.0.1') =>
  app.app.inject({
    method: 'POST', url: '/auth/email/verification/resend', headers: { ...origin, 'x-request-id': 'resend-shared-request-id' }, remoteAddress,
    payload: { email }
  });

const flush = async (app: TestApp): Promise<void> => { await app.emailService.drain(); };

const messagesTo = (sender: FakeEmailSender, email: string): OutgoingEmail[] => sender.sent.filter((message) => message.to === email);

const tokenFrom = (message: OutgoingEmail | undefined): string => {
  const match = /\/email\/verificar\?token=([^\s"&<]+)/.exec(message?.text ?? '');
  if (match?.[1] === undefined) throw new Error('No confirmation link in the message.');
  return decodeURIComponent(match[1]);
};

const userRow = async (email: string) =>
  (await queryAsOwner<{ id: string; emailVerified: boolean }>('select id, "emailVerified" from auth."user" where email = $1', [email]))[0];

/** Everything but what is unique to a request: what a caller could compare between two addresses. */
const comparable = (response: Awaited<ReturnType<typeof signUp>>) => {
  const headers = { ...response.headers };
  delete headers.date;
  delete headers['x-request-id'];
  return { status: response.statusCode, body: response.body, headers };
};

describe('POST /auth/sign-up (#706)', () => {
  it('creates an unconfirmed account with both acceptances and a hashed 24-hour link, and no session', async () => {
    const { app, sender } = await openApp();
    const email = newEmail('sign-up-new');

    const response = await signUp(app, email);
    await flush(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({});
    expect(response.cookies.length).toBe(0);
    const user = await userRow(email);
    expect(user?.emailVerified).toBe(false);
    const sessions = await queryAsOwner('select 1 from auth.session where "userId" = $1', [user?.id]);
    expect(sessions.length).toBe(0);
    const acceptances = await queryAsOwner<{ document: string; version: string }>(
      'select document, version from public.legal_acceptances where user_id = $1 order by document', [user?.id]
    );
    expect(acceptances).toEqual([
      { document: 'privacy', version: app.config.authPrivacyVersion },
      { document: 'terms', version: app.config.authTermsVersion }
    ]);

    const [message] = messagesTo(sender, email);
    const token = tokenFrom(message);
    expect(message?.text).toContain("Se não foi você que criou esta conta, ignore este e-mail. Para usar este endereço, escolha 'Esqueci a senha' na tela de entrada.");
    const rows = await queryAsOwner<{ token_hash: string; hours: number }>(
      'select token_hash, extract(epoch from (expires_at - created_at)) / 3600 as hours from public.email_confirmations where user_id = $1', [user?.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashEmailConfirmationToken(token));
    expect(Number(rows[0]?.hours)).toBeCloseTo(24, 3);
    // The token is random and carries nothing: not the address, not even encoded.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [localPart] = email.split('@');
    for (const form of [token, Buffer.from(token, 'base64url').toString('latin1')]) {
      expect(form.toLowerCase()).not.toContain(email);
      expect(form.toLowerCase()).not.toContain(localPart);
    }
    const link = /https?:\/\/\S*\/email\/verificar\?\S+/.exec(message?.text ?? '')?.[0] ?? '';
    expect(new URL(link).searchParams.size).toBe(1);
    expect(link.toLowerCase()).not.toContain(encodeURIComponent(email).toLowerCase());
  });

  it('answers a confirmed address, an unconfirmed one and a new one the same, and the taken ones get the notice and no link', async () => {
    const { app, sender } = await openApp();
    const confirmed = await insertTestUser(app.pool, app.auth, { email: newEmail('sign-up-taken-confirmed') });
    const unconfirmed = await insertTestUser(app.pool, app.auth, { email: newEmail('sign-up-taken-unconfirmed'), emailVerified: false });
    const fresh = newEmail('sign-up-fresh');

    const timed = async (email: string) => {
      const started = performance.now();
      const response = await signUp(app, email, `10.7.0.${createdEmails.indexOf(email) + 1}`);
      return { response, ms: performance.now() - started };
    };
    // Warm the hasher and the pool, so the first measured request does not pay for them.
    await signUp(app, newEmail('sign-up-warmup'), '10.7.9.9');
    const results = [await timed(confirmed.email), await timed(unconfirmed.email), await timed(fresh)];
    await flush(app);

    const [first, ...rest] = results.map(({ response }) => comparable(response));
    for (const other of rest) expect(other).toEqual(first);
    expect(first?.status).toBe(202);
    const times = results.map(({ ms }) => ms);
    expect(Math.max(...times)).toBeLessThan(Math.min(...times) * 3 + 50);

    for (const taken of [confirmed, unconfirmed]) {
      const messages = messagesTo(sender, taken.email);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toContain("'Esqueci a senha'");
      expect(messages[0]?.text).not.toContain('/email/verificar');
      const links = await queryAsOwner('select 1 from public.email_confirmations where user_id = $1', [taken.id]);
      expect(links.length).toBe(0);
    }
    expect((await queryAsOwner<{ name: string }>('select name from auth."user" where id = $1', [unconfirmed.id]))[0]?.name).toBe(unconfirmed.name);
    expect(tokenFrom(messagesTo(sender, fresh)[0])).not.toBe('');
  });

  it('answers a login with the password chosen at sign-up the same for a new and a taken address (security review of PR #722)', async () => {
    const { app, sender } = await openApp();
    const taken = await insertTestUser(app.pool, app.auth, { email: newEmail('sign-up-oracle-taken') });
    const fresh = newEmail('sign-up-oracle-fresh');
    const chosen = 'the prober chose this password';
    const signUpWith = (email: string, remoteAddress: string) => app.app.inject({
      method: 'POST', url: '/auth/sign-up', headers: origin, remoteAddress,
      payload: { name: 'Quem Sonda', email, password: chosen, acceptTerms: true }
    });
    const loginWith = (email: string, candidate: string, remoteAddress: string) => app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': 'login-shared-request-id' }, remoteAddress, payload: { email, password: candidate }
    });

    await signUpWith(taken.email, '10.12.0.1');
    await signUpWith(fresh, '10.12.0.2');
    const answers = [
      await loginWith(taken.email, chosen, '10.12.0.1'),
      await loginWith(fresh, chosen, '10.12.0.2'),
      await loginWith(fresh, 'not the password at all', '10.12.0.3')
    ].map(comparable);

    for (const other of answers.slice(1)) expect(other).toEqual(answers[0]);
    expect(answers[0]?.status).toBe(401);
    expect(JSON.parse(answers[0]?.body ?? '{}')).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect((await userRow(fresh))?.emailVerified).toBe(false);
    expect(await queryAsOwner('select 1 from auth.session where "userId" = $1', [(await userRow(fresh))?.id])).toHaveLength(0);

    // No side effect: no new link, so nothing to observe afterwards (second review of PR #722).
    await new Promise((resolve) => setTimeout(resolve, 100));
    await flush(app);
    expect(messagesTo(sender, fresh).filter((message) => message.text.includes('/email/verificar'))).toHaveLength(1);
    expect(messagesTo(sender, taken.email).filter((message) => message.text.includes('/email/verificar'))).toHaveLength(0);
  });

  it('answers a resend after logins with the chosen password the same for a new and a taken address, per IP and per e-mail (second review of PR #722)', async () => {
    const { app } = await openApp();
    const chosen = 'the prober chose this password too';
    const probe = async (label: string, loginIps: readonly string[], resendIp: string) => {
      const taken = await insertTestUser(app.pool, app.auth, { email: newEmail(`${label}-taken`) });
      const fresh = newEmail(`${label}-fresh`);
      const results = [];
      for (const [index, email] of [taken.email, fresh].entries()) {
        await app.app.inject({
          method: 'POST', url: '/auth/sign-up', headers: origin, remoteAddress: `10.18.${index}.250`,
          payload: { name: 'Quem Sonda', email, password: chosen, acceptTerms: true }
        });
        for (const ip of loginIps) {
          const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, remoteAddress: ip.replace('X', String(index)), payload: { email, password: chosen } });
          expect(login.statusCode).toBe(401);
        }
        results.push(comparable(await app.app.inject({
          method: 'POST', url: '/auth/email/verification/resend', headers: { ...origin, 'x-request-id': 'resend-probe-request-id' },
          remoteAddress: resendIp.replace('X', String(index)), payload: { email }
        })));
      }
      expect(results[1]).toEqual(results[0]);
      expect(results[0]?.status).toBe(202);
    };

    // Per IP and e-mail: three logins and the resend from one IP.
    await probe('resend-probe-ip', ['10.19.X.1', '10.19.X.1', '10.19.X.1'], '10.19.X.1');
    // Per e-mail: ten logins from ten IPs, then the resend from another.
    await probe('resend-probe-email', Array.from({ length: 10 }, (_, attempt) => `10.20.X.${attempt + 1}`), '10.20.X.200');
  });

  it('limits sign-ups by IP and e-mail with the same 429', async () => {
    const { app } = await openApp();
    const email = newEmail('sign-up-limit');
    const answers = [];
    for (let attempt = 0; attempt < 4; attempt += 1) answers.push((await signUp(app, email, '10.8.0.1')).statusCode);
    expect(answers).toEqual([202, 202, 202, 429]);
    expect((await signUp(app, email, '10.8.0.1')).json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});

describe('POST /auth/email/verify asks for the password (finding A1 of the review of PR #720)', () => {
  const signedUp = async (label: string) => {
    const { app, sender } = await openApp();
    const email = newEmail(label);
    await signUp(app, email);
    await flush(app);
    return { app, sender, email, token: tokenFrom(messagesTo(sender, email)[0]) };
  };

  it('confirms with the link and the right password, signs in, and the link works once', async () => {
    const { app, email, token } = await signedUp('verify-ok');

    const response = await verify(app, token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email } });
    expect(response.cookies.length).toBeGreaterThan(0);
    const user = await userRow(email);
    expect(user?.emailVerified).toBe(true);
    const cookie = response.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    const session = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    const resolved = await app.app.inject({ method: 'GET', url: '/me/contexts/resolve', headers: { cookie } });
    expect(resolved.json()).toEqual({ decision: 'none' });

    const again = await verify(app, token);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
  });

  it('a wrong password changes nothing and answers exactly like a link that is not valid', async () => {
    const { app, email, token } = await signedUp('verify-wrong-password');

    const wrong = await verify(app, token, 'the attacker does not know this');
    const invalid = await verify(app, 'a-token-that-was-never-issued', 'the attacker does not know this');

    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toBe(invalid.body);
    expect(wrong.cookies.length).toBe(0);
    expect((await userRow(email))?.emailVerified).toBe(false);
    expect((await verify(app, token)).statusCode).toBe(200);
  });

  it('refuses an expired link even with the right password', async () => {
    const { app, email, token } = await signedUp('verify-expired');
    await queryAsOwner('update public.email_confirmations set expires_at = now() - interval \'1 second\' where token_hash = $1', [hashEmailConfirmationToken(token)]);

    const response = await verify(app, token);

    expect(response.statusCode).toBe(400);
    expect((await userRow(email))?.emailVerified).toBe(false);
  });

  it('counts wrong passwords on the login counters', async () => {
    const { app, email, token } = await signedUp('verify-limit');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await verify(app, token, 'wrong password attempt', '10.9.0.1')).statusCode).toBe(400);
    }
    expect((await verify(app, token, password, '10.9.0.1')).statusCode).toBe(429);
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, remoteAddress: '10.9.0.1', payload: { email, password } });
    expect(login.statusCode).toBe(429);
  });

  it('a resend invalidates the previous link, and answers the same for any address', async () => {
    const { app, sender, email, token } = await signedUp('verify-resend');
    const confirmed = await insertTestUser(app.pool, app.auth, { email: newEmail('verify-resend-confirmed') });

    const answers = [await resend(app, email, '10.10.0.1'), await resend(app, confirmed.email, '10.10.0.2'), await resend(app, uniqueTestEmail('verify-resend-nobody'), '10.10.0.3')];
    await flush(app);

    for (const answer of answers) expect({ status: answer.statusCode, body: answer.body }).toEqual({ status: 202, body: '{}' });
    expect(messagesTo(sender, confirmed.email)).toHaveLength(0);
    const messages = messagesTo(sender, email);
    expect(messages).toHaveLength(2);
    const newToken = tokenFrom(messages[1]);
    expect((await verify(app, token)).statusCode).toBe(400);
    expect((await verify(app, newToken)).statusCode).toBe(200);
  });

  it('limits the resend by IP and e-mail, and by e-mail from any IP, with the same 429', async () => {
    const { app } = await openApp();
    const email = newEmail('resend-limit');
    const sameIp = [];
    for (let attempt = 0; attempt < 4; attempt += 1) sameIp.push((await resend(app, email, '10.14.0.1')).statusCode);
    expect(sameIp).toEqual([202, 202, 202, 429]);

    const other = newEmail('resend-limit-global');
    const anyIp = [];
    for (let attempt = 0; attempt < 11; attempt += 1) anyIp.push((await resend(app, other, `10.15.0.${attempt + 1}`)).statusCode);
    expect(anyIp).toEqual([...Array<number>(10).fill(202), 429]);
    expect((await resend(app, other, '10.15.1.1')).json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('caps the confirmation at 100 requests per IP', async () => {
    const { app } = await openApp();
    const answers = [];
    for (let attempt = 0; attempt < 101; attempt += 1) {
      answers.push((await verify(app, `a-token-never-issued-${attempt}`, 'any password at all', '10.16.0.1')).statusCode);
    }
    expect(answers.slice(0, 100).every((status) => status === 400)).toBe(true);
    expect(answers[100]).toBe(429);
  }, 120_000);

  it('confirming with the old password while the password is reset never answers 500, and exactly one of the two takes effect', async () => {
    const { app, sender } = await openApp();
    const accounts: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const email = newEmail(`verify-reset-race-${index}`);
      await signUp(app, email, `10.17.0.${index + 1}`);
      await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, remoteAddress: `10.17.1.${index + 1}`, payload: { email } });
      accounts.push(email);
    }
    await flush(app);
    const newPassword = 'the reset chose this one instead';

    const results = await Promise.all(accounts.map(async (email) => {
      const messages = messagesTo(sender, email);
      const token = tokenFrom(messages.find((message) => message.text.includes('/email/verificar')));
      const resetToken = decodeURIComponent(/token=([^\s&]+)/.exec(messages.find((message) => message.text.includes('/senha/redefinir'))?.text ?? '')?.[1] ?? '');
      const [confirmed, reset] = await Promise.all([
        verify(app, token, password, `10.17.2.${accounts.indexOf(email) + 1}`),
        app.app.inject({ method: 'POST', url: '/auth/password/reset', headers: origin, payload: { token: resetToken, newPassword } })
      ]);
      return { email, confirmed: confirmed.statusCode, reset: reset.statusCode };
    }));

    for (const { email, confirmed, reset } of results) {
      expect([200, 400]).toContain(confirmed);
      expect(reset).toBe(204);
      const user = await userRow(email);
      expect(user?.emailVerified).toBe(true);
      const consumed = await queryAsOwner('select 1 from public.email_confirmations where user_id = $1 and consumed_at is not null', [user?.id]);
      const revoked = await queryAsOwner('select 1 from public.legal_acceptances where user_id = $1 and revoked_at is not null', [user?.id]);
      // Either the link confirmed the account first, or the reset took it over and revoked the acceptances.
      expect([consumed.length > 0, revoked.length > 0].filter(Boolean)).toHaveLength(1);
      const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, remoteAddress: '10.17.3.1', payload: { email, password: newPassword } });
      expect(login.statusCode).toBe(200);
    }
  });

  it('answers a sign-in that fails after the link was consumed as an invalid link, never 500', async () => {
    const { app, email, token } = await signedUp('verify-sign-in-fails');
    const user = await userRow(email);
    // Stands in for a reset that lands between consuming the link and signing in: the password is
    // replaced in the same transaction that consumes the link.
    const name = `test_swap_password_${user?.id.replace(/-/g, '') ?? ''}`;
    await queryAsOwner(`create function public.${name}() returns trigger language plpgsql as $$ begin
      update auth.account set password = 'replaced-by-a-reset' where "userId" = new.user_id and "providerId" = 'credential';
      return new; end $$`);
    await queryAsOwner(`create trigger ${name} after update of consumed_at on public.email_confirmations
      for each row when (new.user_id = '${user?.id ?? ''}'::uuid) execute function public.${name}()`);
    try {
      const response = await verify(app, token);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
      expect(response.cookies.length).toBe(0);
      expect((await userRow(email))?.emailVerified).toBe(true);
    } finally {
      await queryAsOwner(`drop trigger if exists ${name} on public.email_confirmations`);
      await queryAsOwner(`drop function if exists public.${name}()`);
    }
  });

  it('the reset of an unconfirmed account confirms it, replaces the password and voids the pending links', async () => {
    const { app, sender, email, token } = await signedUp('verify-reset');

    await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email } });
    await flush(app);
    const resetMessage = messagesTo(sender, email).find((message) => message.text.includes('/senha/redefinir'));
    const resetToken = decodeURIComponent(/token=([^\s&]+)/.exec(resetMessage?.text ?? '')?.[1] ?? '');
    const newPassword = 'the owner of the mailbox chose this';
    const reset = await app.app.inject({ method: 'POST', url: '/auth/password/reset', headers: origin, payload: { token: resetToken, newPassword } });
    expect(reset.statusCode).toBe(204);

    const user = await userRow(email);
    expect(user?.emailVerified).toBe(true);
    expect(await queryAsOwner('select 1 from public.email_confirmations where user_id = $1 and consumed_at is null', [user?.id])).toHaveLength(0);
    expect((await verify(app, token, newPassword)).statusCode).toBe(400);
    expect((await verify(app, token, password)).statusCode).toBe(400);
    const oldLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password: newPassword } });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.cookies.length).toBeGreaterThan(0);
    expect(reset.cookies.length).toBe(0);

    // The acceptance recorded by whoever signed up is revoked, and the owner of the mailbox accepts again.
    const revoked = await queryAsOwner<{ revoked: boolean }>('select revoked_at is not null as revoked from public.legal_acceptances where user_id = $1', [user?.id]);
    expect(revoked.map((row) => row.revoked)).toEqual([true, true]);
    const cookie = newLogin.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    const legal = await app.app.inject({ method: 'GET', url: '/me/legal-acceptances', headers: { cookie } });
    expect(legal.json()).toMatchObject({ documents: [{ document: 'terms', pending: true }, { document: 'privacy', pending: true }] });
  });
});
