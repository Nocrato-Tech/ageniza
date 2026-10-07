import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAgencyCliDatabase } from '../../cli/agency.js';
import { isRetryableConflict } from './service.js';
import { runEmailChangeCli, type EmailChangeConfirmationEmail, type EmailChangeMailer } from '../../cli/email-change.js';
import {
  buildTestApp,
  captureLogs,
  createFakeEmailSender,
  insertTestUser,
  OWNER_DATABASE_URL,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type CapturedLogs,
  type FakeEmailSender,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Issue #80 acceptance tests, against the real local database (`pnpm db:migrate`). The e-mail goes
// through a fake at the sender seam (the same one the auth suites use) and the operation's mailer
// is a fake that only records what the CLI built.
const origin = { origin: TEST_APP_PUBLIC_URL };

let app: TestApp;
let sender: FakeEmailSender;
let logs: CapturedLogs;
const owner = ownerClient();
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];
const createdInvitationIds: string[] = [];

const mailed: EmailChangeConfirmationEmail[] = [];
const mailer: EmailChangeMailer = {
  sendConfirmationEmail: async (message) => { mailed.push(message); },
  close: async () => undefined
};

const newAddress = (label: string): string => `${label}.${randomUUID().slice(0, 8)}@email-change.test`;

const cookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const createAgency = async (ownerUserId: string | null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name: `Troca ${id.slice(0, 8)}`, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

/** A user with one context, so the login is not refused for having none. Owns the agency by default. */
const makeUser = async (label: string, options: { readonly agencyOwner?: boolean } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  if (options.agencyOwner ?? false) await createAgency(user.id);
  else await joinAgency(user.id);
  return user;
};

/** A member with the Production preset in somebody else's agency: no ownership anywhere. */
const joinAgency = async (userId: string): Promise<void> => {
  const agencyId = await createAgency(null);
  const role = await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: role.id, status: 'active' });
};

const login = async (email: string, password: string): Promise<{ status: number; cookie: string }> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });
  return { status: response.statusCode, cookie: cookieHeader(response.cookies) };
};

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const result = await login(user.email, user.password);
  expect(result.status).toBe(200);
  return result.cookie;
};

const sessionStatus = async (cookie: string): Promise<number> =>
  (await app.app.inject({ method: 'GET', url: '/auth/session', headers: { ...origin, cookie } })).statusCode;

const requestChange = async (cookie: string | undefined, payload: unknown) => {
  const response = await app.app.inject({
    method: 'POST',
    url: '/me/email-change',
    headers: cookie === undefined ? origin : { ...origin, cookie },
    payload: payload as never
  });
  return { status: response.statusCode, body: response.json() as { error?: { code: string }; meta?: unknown }, raw: response.body };
};

let nextClient = 0;
/** Each call comes from its own address, so the per-IP ceiling of the public route stays out of the way. */
const freshClientAddress = (): string => `10.80.${Math.floor(nextClient / 250)}.${(nextClient++ % 250) + 1}`;

const confirmLink = async (token: unknown, headers: Record<string, string> = origin, remoteAddress: string = freshClientAddress()) => {
  const response = await app.app.inject({ method: 'POST', url: '/email-change/confirm', headers, payload: { token } as never, remoteAddress });
  return { status: response.statusCode, body: response.json() as { error?: { code: string; message: string } } };
};

const operate = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEmailChangeCli({
    argv,
    environment: {
      MIGRATION_DATABASE_URL: OWNER_DATABASE_URL,
      SMTP_URL: 'smtp://127.0.0.1:1025',
      EMAIL_FROM: 'Ageniza <no-reply@ageniza.local>',
      APP_PUBLIC_URL: TEST_APP_PUBLIC_URL
    },
    io: { stdout: { write: (chunk) => { out.push(chunk); } }, stderr: { write: (chunk) => { err.push(chunk); } } },
    database: createAgencyCliDatabase(OWNER_DATABASE_URL),
    mailer
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
};

const requestRow = async (userId: string) =>
  owner.knex('email_change_requests').where({ user_id: userId }).orderBy('requested_at', 'desc').first();
const requestsOf = (userId: string) =>
  owner.knex('email_change_requests').where({ user_id: userId }).orderBy('requested_at').select('id', 'status', 'new_email', 'old_email', 'ownership_confirmed_at');
const emailOf = async (userId: string): Promise<string> => (await owner.knex('auth.user').where({ id: userId }).first('email')).email;

const sentTo = async (address: string) => {
  await app.emailService.drain();
  return sender.sent.filter((message) => message.to === address);
};

const tokenOf = (message: EmailChangeConfirmationEmail | undefined): string => {
  const token = message === undefined ? null : new URL(message.actionUrl).searchParams.get('token');
  if (token === null) throw new Error('The operation mailed no link.');
  return token;
};

interface RequestLockHolder {
  readonly locked: Promise<void>;
  /** Releases the row lock without ever asking for the account. */
  release(): void;
  /** Asks for the account's row lock while still holding the request's, which closes the cycle. */
  wantAccount(): void;
  readonly done: Promise<void>;
}

/**
 * Holds the row lock of one request in a real owner transaction, so the transactions under test
 * line up behind it in a known order. With `wantAccount` it then asks for the account's lock, the
 * other half of a deadlock against whoever holds the account and waits for the request.
 */
const holdRequestLock = (requestId: string, userId: string): RequestLockHolder => {
  let proceed: (account: boolean) => void = () => undefined;
  const gate = new Promise<boolean>((resolve) => { proceed = resolve; });
  let markLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const done = owner.knex.transaction(async (transaction) => {
    await transaction.raw('select id from public.email_change_requests where id = ? for update', [requestId]);
    markLocked();
    if (await gate) await transaction.raw('select id from auth."user" where id = ? for update', [userId]);
  });
  return { locked, release: () => proceed(false), wantAccount: () => proceed(true), done: done.then(() => undefined) };
};

/** Waits until a backend running a statement that matches the pattern is blocked on a lock. */
const waitUntilBlocked = async (statementPattern: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await owner.knex.raw(
      `select count(*)::int as waiting from pg_catalog.pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and query ilike ?`, [statementPattern]
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend running ${statementPattern} ever waited on a lock.`);
};

const insertOpenRequest = async (user: TestUserFixture): Promise<string> => {
  const id = randomUUID();
  // Recorded like `request_email_change` does, or the request would look as if it predated the credential.
  const fingerprint = (await owner.knex.raw('select app_private.credential_fingerprint(?::uuid) as fingerprint', [user.id])).rows[0]?.fingerprint ?? null;
  await owner.knex('email_change_requests').insert({
    id, user_id: user.id, old_email: user.email, new_email: newAddress('race-new'), status: 'pending', credential_fingerprint: fingerprint
  });
  return id;
};

const LOCKED_READ_OF_A_REQUEST = '%from public.email_change_requests where id%for update%';

/** Asks, approves, and returns the token the CLI mailed to the new address. */
const askAndApprove = async (user: TestUserFixture, address: string, flags: string[] = []): Promise<string> => {
  const cookie = await loginCookie(user);
  expect((await requestChange(cookie, { newEmail: address, currentPassword: user.password })).status).toBe(202);
  const row = await requestRow(user.id);
  const before = mailed.length;
  const result = await operate('approve', '--request-id', row.id, ...flags);
  expect(result.code, result.stderr).toBe(0);
  expect(mailed).toHaveLength(before + 1);
  return tokenOf(mailed[mailed.length - 1]);
};

describe('account e-mail change by request (issue #80)', () => {
  beforeAll(async () => {
    logs = captureLogs();
    sender = createFakeEmailSender();
    app = await buildTestApp({ logger: logs.logger, sender });
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const userIds = [...new Set(createdUserIds)];
    await owner.knex('audit.events').whereIn('actor_user_id', userIds).delete();
    await owner.knex('audit.events').where({ target_type: 'email_change_request' }).whereNull('actor_user_id').delete();
    await owner.knex('invitations').whereIn('id', createdInvitationIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', userIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth.verification where value = any($1::text[])', [userIds]);
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [userIds]);
    await app.close();
    await owner.close();
  });

  describe('asking for the change', () => {
    it('needs a session', async () => {
      const denied = await requestChange(undefined, { newEmail: newAddress('anon'), currentPassword: 'x' });
      expect(denied.status).toBe(401);
      expect(denied.body.error?.code).toBe('UNAUTHENTICATED');
    });

    it('with the wrong current password creates no request and sends nothing', async () => {
      const user = await makeUser('wrong-password');
      const cookie = await loginCookie(user);
      const before = (await sentTo(user.email)).length;

      const denied = await requestChange(cookie, { newEmail: newAddress('wp-new'), currentPassword: 'a different but long password' });

      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe('INVALID_PASSWORD');
      expect(await requestsOf(user.id)).toEqual([]);
      expect(await sentTo(user.email)).toHaveLength(before);
      expect(await sessionStatus(cookie)).toBe(200);
    });

    it('with the right password records one pending request and warns the CURRENT address, never the new one', async () => {
      const user = await makeUser('asker');
      const cookie = await loginCookie(user);
      const address = newAddress('asker-new');

      const accepted = await requestChange(cookie, { newEmail: address.toUpperCase(), currentPassword: user.password });

      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({});
      expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'pending', new_email: address, old_email: user.email })]);
      const notices = await sentTo(user.email);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.template).toBe('email-change-requested');
      expect(notices[0]?.text).toContain('Pediram a troca do e-mail desta conta');
      expect(notices[0]?.text).toContain('troque a senha');
      expect(notices[0]?.text).not.toMatch(/https?:/);
      expect(await sentTo(address)).toEqual([]);
      expect(await emailOf(user.id)).toBe(user.email);
      expect(await sessionStatus(cookie)).toBe(200);
    });

    it('refuses an unknown field, a malformed address and the address the account already has, recording nothing', async () => {
      const user = await makeUser('refused');
      const cookie = await loginCookie(user);

      for (const payload of [
        { newEmail: newAddress('x'), currentPassword: user.password, userId: randomUUID() },
        { newEmail: 'not-an-address', currentPassword: user.password },
        { newEmail: newAddress('x') },
        { currentPassword: user.password },
        { newEmail: newAddress('x'), currentPassword: '' }
      ]) {
        const denied = await requestChange(cookie, payload);
        expect({ payload, status: denied.status }).toEqual({ payload, status: 400 });
        expect(denied.body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(await requestsOf(user.id)).toEqual([]);

      // A separate account: every call counts against the per-account ceiling, refused ones too.
      const other = await makeUser('refused-same');
      const same = await requestChange(await loginCookie(other), { newEmail: `  ${other.email.toUpperCase()}`, currentPassword: other.password });
      expect(same.status).toBe(400);
      expect(same.body.error?.code).toBe('SAME_EMAIL');
      expect(await requestsOf(other.id)).toEqual([]);
    });

    it('answers exactly the same when the new address belongs to another account, and the operation sees the collision', async () => {
      const holder = await makeUser('holder');
      const asker = await makeUser('collision-asker');
      const cookie = await loginCookie(asker);

      const free = await requestChange(cookie, { newEmail: newAddress('free'), currentPassword: asker.password });
      const taken = await requestChange(cookie, { newEmail: holder.email, currentPassword: asker.password });

      expect(taken.status).toBe(free.status);
      expect(taken.raw).toBe(free.raw);
      expect(await sentTo(holder.email)).toEqual([]);
      expect((await sentTo(asker.email)).map((message) => message.template)).toEqual(['email-change-requested', 'email-change-requested']);
      expect(await requestsOf(asker.id)).toEqual([
        expect.objectContaining({ status: 'superseded' }),
        expect.objectContaining({ status: 'pending', new_email: holder.email })
      ]);

      const row = await requestRow(asker.id);
      const listed = JSON.parse((await operate('list')).stdout) as { requestId: string; newEmailInUse: boolean }[];
      expect(listed.find((entry) => entry.requestId === row.id)?.newEmailInUse).toBe(true);
      const approval = await operate('approve', '--request-id', row.id);
      expect(approval.code).toBe(1);
      expect(approval.stderr).toContain('already belongs to another account');
      expect((await requestRow(asker.id)).status).toBe('pending');
    });

    it('keeps one open request per account: the new one replaces the previous', async () => {
      const user = await makeUser('replacer');
      const cookie = await loginCookie(user);

      await requestChange(cookie, { newEmail: newAddress('first'), currentPassword: user.password });
      await requestChange(cookie, { newEmail: newAddress('second'), currentPassword: user.password });

      expect((await requestsOf(user.id)).map((row) => row.status)).toEqual(['superseded', 'pending']);
    });

    it('needs no module permission: a role holding one unrelated permission may ask', async () => {
      const agencyId = await createAgency(null);
      const roleId = randomUUID();
      createdRoleIds.push(roleId);
      await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Custom', is_system: false });
      await owner.knex('role_permissions').insert({ role_id: roleId, permission_key: 'midia.enviar' });
      const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'single-permission' });
      createdUserIds.push(user.id);
      await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: user.id, role_id: roleId, status: 'active' });
      const cookie = await loginCookie(user);

      const accepted = await requestChange(cookie, { newEmail: newAddress('sp-new'), currentPassword: user.password });

      expect(accepted.status).toBe(202);
    });

    it('limits the attempts per account, wrong passwords included', async () => {
      const user = await makeUser('limited');
      const cookie = await loginCookie(user);
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await requestChange(cookie, { newEmail: newAddress('limit'), currentPassword: 'a wrong password for sure' })).status);
      }

      expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
    });

    it('limits the public confirmation per client address', async () => {
      const address = '10.99.99.99';
      const statuses: number[] = [];

      for (let attempt = 0; attempt < 21; attempt += 1) statuses.push((await confirmLink('a-guess', origin, address)).status);

      expect(statuses).toEqual([...Array(20).fill(400), 429]);
      expect((await confirmLink('a-guess', origin, '10.99.99.98')).status).toBe(400);
    });

    it('answers a malformed or empty JSON body with 400, without an error log', async () => {
      const user = await makeUser('malformed');
      const cookie = await loginCookie(user);
      const before = logs.text().length;

      for (const payload of ['{"newEmail": ', '']) {
        const response = await app.app.inject({
          method: 'POST', url: '/me/email-change', headers: { ...origin, cookie, 'content-type': 'application/json' }, payload
        });
        expect(response.statusCode).toBe(400);
      }

      expect(logs.text().slice(before)).not.toMatch(/"level":50/);
    });

    it('rejects a request from a foreign origin on both routes', async () => {
      const user = await makeUser('csrf');
      const cookie = await loginCookie(user);
      const foreign = { origin: 'https://evil.example', cookie };

      const asked = await app.app.inject({ method: 'POST', url: '/me/email-change', headers: foreign, payload: { newEmail: newAddress('csrf'), currentPassword: user.password } });
      const confirmed = await app.app.inject({ method: 'POST', url: '/email-change/confirm', headers: { origin: 'https://evil.example' }, payload: { token: 'x' } });

      expect(asked.statusCode).toBe(403);
      expect(confirmed.statusCode).toBe(403);
      expect(await requestsOf(user.id)).toEqual([]);
    });
  });

  describe('the link in the new mailbox', () => {
    it('does not swap anything while the request is not approved, whatever the link', async () => {
      const user = await makeUser('unapproved');
      const cookie = await loginCookie(user);
      await requestChange(cookie, { newEmail: newAddress('un-new'), currentPassword: user.password });
      const row = await requestRow(user.id);

      for (const token of [row.id, row.new_email, 'a-guess', 'x'.repeat(100)]) {
        const denied = await confirmLink(token);
        expect({ token, status: denied.status, code: denied.body.error?.code }).toEqual({ token, status: 400, code: 'INVALID_LINK' });
      }

      expect(await emailOf(user.id)).toBe(user.email);
      expect(await sessionStatus(cookie)).toBe(200);
      expect((await requestRow(user.id)).status).toBe('pending');
    });

    it('swaps the address, ends every session, and warns the old address once', async () => {
      const user = await makeUser('swap');
      const first = await loginCookie(user);
      const second = await loginCookie(user);
      const address = newAddress('swap-new');
      const token = await askAndApprove(user, address);
      expect(mailed[mailed.length - 1]?.to).toBe(address);
      expect(mailed[mailed.length - 1]?.actionUrl.startsWith(`${TEST_APP_PUBLIC_URL}/email/confirmar?token=`)).toBe(true);
      expect(await emailOf(user.id)).toBe(user.email);
      const noticesBefore = (await sentTo(user.email)).length;

      const confirmed = await confirmLink(token);

      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({});
      expect(await emailOf(user.id)).toBe(address);
      expect((await owner.knex('auth.user').where({ id: user.id }).first('emailVerified')).emailVerified).toBe(true);
      expect(await sessionStatus(first)).toBe(401);
      expect(await sessionStatus(second)).toBe(401);
      expect(await owner.knex('auth.session').where({ userId: user.id }).count('* as total')).toEqual([{ total: '0' }]);
      const changed = (await sentTo(user.email)).slice(noticesBefore);
      expect(changed.map((message) => message.template)).toEqual(['email-changed']);
      expect(changed[0]?.text).toContain('foi alterado');
      expect(changed[0]?.text).not.toMatch(/https?:/);
      expect(await sentTo(address)).toEqual([]);
      expect((await login(user.email, user.password)).status).toBe(401);
      expect((await login(address, user.password)).status).toBe(200);
      expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'completed' })]);
    });

    it('is single-use: spending it again swaps nothing and warns nobody', async () => {
      const user = await makeUser('single-use');
      const address = newAddress('su-new');
      const token = await askAndApprove(user, address);
      expect((await confirmLink(token)).status).toBe(200);
      const noticesBefore = (await sentTo(user.email)).length;

      const again = await confirmLink(token);

      expect(again.status).toBe(400);
      expect(again.body.error?.code).toBe('INVALID_LINK');
      expect(await sentTo(user.email)).toHaveLength(noticesBefore);
      expect(await emailOf(user.id)).toBe(address);
    });

    it('lets exactly one of several simultaneous confirmations through', async () => {
      const user = await makeUser('racing');
      const address = newAddress('race-new');
      const token = await askAndApprove(user, address);

      const results = await Promise.all([confirmLink(token), confirmLink(token), confirmLink(token)]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 400, 400]);
      expect(await emailOf(user.id)).toBe(address);
      expect((await sentTo(user.email)).filter((message) => message.template === 'email-changed')).toHaveLength(1);
    });

    it('does not swap once the link expired', async () => {
      const user = await makeUser('expired');
      const token = await askAndApprove(user, newAddress('exp-new'));
      await owner.knex('email_change_requests').where({ user_id: user.id }).update({ token_expires_at: new Date(Date.now() - 1_000) });

      const expired = await confirmLink(token);

      expect(expired.status).toBe(400);
      expect(expired.body.error?.code).toBe('INVALID_LINK');
      expect(await emailOf(user.id)).toBe(user.email);
    });

    it('dies with a new approval, a new request or a rejection', async () => {
      const resent = await makeUser('resent');
      const firstLink = await askAndApprove(resent, newAddress('resent-new'));
      const row = await requestRow(resent.id);
      expect((await operate('approve', '--request-id', row.id)).code).toBe(0);
      const secondLink = tokenOf(mailed[mailed.length - 1]);
      expect(secondLink).not.toBe(firstLink);
      expect((await confirmLink(firstLink)).status).toBe(400);
      expect(await emailOf(resent.id)).toBe(resent.email);

      const replaced = await makeUser('replaced');
      const replacedLink = await askAndApprove(replaced, newAddress('replaced-new'));
      await requestChange(await loginCookie(replaced), { newEmail: newAddress('replaced-newer'), currentPassword: replaced.password });
      expect((await confirmLink(replacedLink)).status).toBe(400);
      expect(await emailOf(replaced.id)).toBe(replaced.email);

      const rejected = await makeUser('rejected');
      const rejectedLink = await askAndApprove(rejected, newAddress('rejected-new'));
      const rejection = await operate('reject', '--request-id', (await requestRow(rejected.id)).id);
      expect(rejection.code).toBe(0);
      expect((await confirmLink(rejectedLink)).status).toBe(400);
      expect(await emailOf(rejected.id)).toBe(rejected.email);

      expect((await confirmLink(secondLink)).status).toBe(200);
    });

    it('does not swap into an address another account took after the approval, and answers like any dead link', async () => {
      const user = await makeUser('late');
      const address = newAddress('late-new');
      const token = await askAndApprove(user, address);
      const taker = await insertTestUser(app.pool, app.auth, { email: address });
      createdUserIds.push(taker.id);

      const refused = await confirmLink(token);
      const unknown = await confirmLink('not-a-token');

      expect(refused.status).toBe(400);
      expect(refused.body.error).toEqual(unknown.body.error);
      expect(await emailOf(user.id)).toBe(user.email);
      expect(await emailOf(taker.id)).toBe(address);
    });

    it('leaves invitations addressed to the old address as they were', async () => {
      const user = await makeUser('invited');
      const agencyId = await createAgency(null);
      const invitationId = randomUUID();
      createdInvitationIds.push(invitationId);
      await owner.knex('invitations').insert({
        id: invitationId, agency_id: agencyId, purpose: 'agency_activation', email: user.email,
        token_hash: `hash-${invitationId}`, expires_at: new Date(Date.now() + 86_400_000)
      });
      const token = await askAndApprove(user, newAddress('inv-new'));

      expect((await confirmLink(token)).status).toBe(200);

      expect(await owner.knex('invitations').where({ id: invitationId }).first('email', 'used_at', 'revoked_at'))
        .toEqual({ email: user.email, used_at: null, revoked_at: null });
    });

    it('kills a password-reset link already sent to the old address', async () => {
      const user = await makeUser('reset-before');
      const forgot = await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email } });
      expect(forgot.statusCode).toBe(202);
      const resetMail = (await sentTo(user.email)).find((message) => message.template === 'password-reset');
      const resetToken = resetMail?.text.match(/token=([^\s&]+)/)?.[1];
      expect(resetToken).toBeDefined();
      const address = newAddress('reset-new');
      const token = await askAndApprove(user, address);
      expect((await confirmLink(token)).status).toBe(200);

      const reset = await app.app.inject({
        method: 'POST', url: '/auth/password/reset', headers: origin,
        payload: { token: decodeURIComponent(resetToken ?? ''), newPassword: 'an attacker chosen password' }
      });

      expect(reset.statusCode).toBe(400);
      expect(reset.json().error.code).toBe('INVALID_LINK');
      expect((await login(address, 'an attacker chosen password')).status).toBe(401);
      expect((await login(address, user.password)).status).toBe(200);
    });
  });

  describe('races between the three paths that lock an account and its requests', { timeout: 30_000 }, () => {
    it('a request and an approval of the same account both go through, in the account-then-request lock order', async () => {
      const user = await makeUser('race-approve');
      const cookie = await loginCookie(user);
      const requestId = await insertOpenRequest(user);
      const holder = holdRequestLock(requestId, user.id);
      await holder.locked;
      const mailedBefore = mailed.length;

      // The approval lines up first, then the request; once the holder lets go, an approval that
      // locks the request before the account and a request that holds the account wait on each other.
      const approval = operate('approve', '--request-id', requestId);
      await waitUntilBlocked(LOCKED_READ_OF_A_REQUEST);
      const asked = requestChange(cookie, { newEmail: newAddress('race-next'), currentPassword: user.password });
      await waitUntilBlocked('%request_email_change%');
      holder.release();
      await holder.done;

      const [approved, requested] = await Promise.all([approval, asked]);
      expect({ approval: approved.code, stderr: approved.stderr, request: requested.status }).toEqual({ approval: 0, stderr: '', request: 202 });
      expect((await requestsOf(user.id)).map((row) => row.status)).toEqual(['superseded', 'pending']);
      const staleLink = tokenOf(mailed[mailedBefore]);
      expect((await confirmLink(staleLink)).status).toBe(400);
      expect(await emailOf(user.id)).toBe(user.email);
    });

    it('answers 409 TRY_AGAIN, with no detail and nothing changed, when a request loses a deadlock', async () => {
      const user = await makeUser('deadlock-request');
      const cookie = await loginCookie(user);
      const requestId = await insertOpenRequest(user);
      const holder = holdRequestLock(requestId, user.id);
      await holder.locked;
      const noticesBefore = (await sentTo(user.email)).length;

      const asked = requestChange(cookie, { newEmail: newAddress('deadlock-next'), currentPassword: user.password });
      await waitUntilBlocked('%request_email_change%');
      holder.wantAccount();
      const [lost] = await Promise.all([asked, holder.done]);

      expect(lost.status).toBe(409);
      expect(lost.body.error?.code).toBe('TRY_AGAIN');
      expect(lost.raw).not.toMatch(/deadlock|40P01|email_change|pg_|relation|process/i);
      expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ id: requestId, status: 'pending' })]);
      expect(await sentTo(user.email)).toHaveLength(noticesBefore);
      const retried = await requestChange(cookie, { newEmail: newAddress('deadlock-retry'), currentPassword: user.password });
      expect(retried.status).toBe(202);
    });

    it('answers 409 TRY_AGAIN when a confirmation loses a deadlock, and the link still works afterwards', async () => {
      const user = await makeUser('deadlock-confirm');
      const address = newAddress('deadlock-confirm-new');
      const token = await askAndApprove(user, address);
      const requestId = (await requestRow(user.id)).id;
      const holder = holdRequestLock(requestId, user.id);
      await holder.locked;

      const confirming = confirmLink(token);
      await waitUntilBlocked('%confirm_email_change%');
      holder.wantAccount();
      const [lost] = await Promise.all([confirming, holder.done]);

      expect(lost.status).toBe(409);
      expect(lost.body.error?.code).toBe('TRY_AGAIN');
      expect(JSON.stringify(lost.body)).not.toMatch(/deadlock|40P01|email_change|pg_|relation|process/i);
      expect(await emailOf(user.id)).toBe(user.email);
      expect((await requestRow(user.id)).status).toBe('approved');

      expect((await confirmLink(token)).status).toBe(200);
      expect(await emailOf(user.id)).toBe(address);
    });

    it('makes the operation say to run the command again when an approval loses a deadlock, and changes nothing', async () => {
      const user = await makeUser('deadlock-approve');
      const requestId = await insertOpenRequest(user);
      const holder = holdRequestLock(requestId, user.id);
      await holder.locked;
      const mailedBefore = mailed.length;

      const approval = operate('approve', '--request-id', requestId);
      await waitUntilBlocked(LOCKED_READ_OF_A_REQUEST);
      holder.wantAccount();
      const [lost] = await Promise.all([approval, holder.done]);

      expect(lost.code).toBe(1);
      expect(lost.stderr).toContain('Run the command again');
      expect(lost.stderr).not.toMatch(/deadlock|40P01/i);
      expect(mailed).toHaveLength(mailedBefore);
      expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ id: requestId, status: 'pending' })]);
      expect((await operate('approve', '--request-id', requestId)).code).toBe(0);
    });

    it('treats a deadlock and a serialization failure as a lost race, and nothing else', () => {
      expect(isRetryableConflict({ code: '40P01' })).toBe(true);
      expect(isRetryableConflict({ code: '40001' })).toBe(true);
      for (const other of [{ code: 'A0042' }, { code: '23505' }, { code: '42501' }, { code: '57014' }, new Error('x'), null, undefined, 'x']) {
        expect(isRetryableConflict(other), String(other)).toBe(false);
      }
    });
  });

  // The notice to the current address says "if it was not you, change the password". So changing the
  // password must undo what the notice announced: the request, and the link if one was issued. Two
  // barriers hold it (security review of PR #325): the reset closes the account's open requests, and
  // the approval and the confirmation refuse a request made under a credential that no longer exists.
  describe('changing the password undoes the request the notice told the person to undo', () => {
    /** The real "Esqueci a senha" flow: the mailed link, then the new password. */
    const resetPassword = async (user: TestUserFixture, newPassword: string): Promise<void> => {
      const noticesBefore = (await sentTo(user.email)).length;
      const forgot = await app.app.inject({
        method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email }, remoteAddress: freshClientAddress()
      });
      expect(forgot.statusCode).toBe(202);
      const mail = (await sentTo(user.email)).slice(noticesBefore).find((message) => message.template === 'password-reset');
      const token = mail?.text.match(/token=([^\s&]+)/)?.[1];
      expect(token).toBeDefined();
      const reset = await app.app.inject({
        method: 'POST', url: '/auth/password/reset', headers: origin, remoteAddress: freshClientAddress(),
        payload: { token: decodeURIComponent(token ?? ''), newPassword }
      });
      expect(reset.statusCode, reset.body).toBe(200);
    };

    /** A credential changed by a path that never calls the reset's hook, which only the second barrier can catch. */
    const changeCredentialBehindTheHook = async (userId: string): Promise<void> => {
      await owner.knex('auth.account').where({ userId, providerId: 'credential' }).update({ password: `swapped-${randomUUID()}`, updatedAt: new Date() });
    };

    it('closes the pending request, so the operation has nothing to approve and the account stays as it was', async () => {
      const victim = await makeUser('reset-pending');
      const bystander = await makeUser('reset-bystander');
      const victimCookie = await loginCookie(victim);
      const attacker = newAddress('attacker-pending');
      expect((await requestChange(victimCookie, { newEmail: attacker, currentPassword: victim.password })).status).toBe(202);
      const row = await requestRow(victim.id);
      const bystanderRequest = await requestChange(await loginCookie(bystander), { newEmail: newAddress('bystander-new'), currentPassword: bystander.password });
      expect(bystanderRequest.status).toBe(202);
      const mailedBefore = mailed.length;

      await resetPassword(victim, 'the victim chose this one');

      expect(await sessionStatus(victimCookie)).toBe(401);
      expect(await owner.knex('email_change_requests').where({ id: row.id }).first('status', 'token_hash', 'token_expires_at'))
        .toEqual({ status: 'superseded', token_hash: null, token_expires_at: null });
      const listed = JSON.parse((await operate('list')).stdout) as { requestId: string }[];
      expect(listed.map((entry) => entry.requestId)).not.toContain(row.id);

      const approval = await operate('approve', '--request-id', row.id);

      expect(approval.code).toBe(1);
      expect(approval.stderr).toContain('superseded');
      expect(mailed).toHaveLength(mailedBefore);
      expect(await emailOf(victim.id)).toBe(victim.email);
      // Someone else's request is not touched by this reset.
      expect(await requestsOf(bystander.id)).toEqual([expect.objectContaining({ status: 'pending' })]);
    });

    it('kills the link of an approved request: the link sent to the new address no longer swaps anything', async () => {
      const victim = await makeUser('reset-approved');
      const attacker = newAddress('attacker-approved');
      const token = await askAndApprove(victim, attacker);
      expect((await requestRow(victim.id)).status).toBe('approved');

      await resetPassword(victim, 'the victim chose this one');

      expect(await requestsOf(victim.id)).toEqual([expect.objectContaining({ status: 'superseded' })]);
      expect((await requestRow(victim.id)).token_hash).toBeNull();
      const confirmed = await confirmLink(token);
      expect(confirmed.status).toBe(400);
      expect(confirmed.body.error?.code).toBe('INVALID_LINK');
      expect(await emailOf(victim.id)).toBe(victim.email);
      expect((await login(victim.email, 'the victim chose this one')).status).toBe(200);
      expect((await login(attacker, 'the victim chose this one')).status).toBe(401);
    });

    it('does not stop the person from asking again afterwards, under the new password', async () => {
      const user = await makeUser('reset-then-ask');
      await requestChange(await loginCookie(user), { newEmail: newAddress('first-ask'), currentPassword: user.password });
      await resetPassword(user, 'a password chosen after the reset');
      const afterReset = { ...user, password: 'a password chosen after the reset' };
      const address = newAddress('second-ask');

      const token = await askAndApprove(afterReset, address);

      expect((await confirmLink(token)).status).toBe(200);
      expect(await emailOf(user.id)).toBe(address);
    });

    it('refuses a request whose password was verified before a reset that landed between the check and the insert, so no link can ever swap the address', async () => {
      const victim = await makeUser('reset-in-flight');
      const cookie = await loginCookie(victim);
      const attacker = newAddress('attacker-in-flight');
      const noticesBefore = (await sentTo(victim.email)).filter((message) => message.template === 'email-change-requested').length;
      // The verification is the real one; the victim's reset (the real "Esqueci a senha" flow, hook
      // included) is made to land right after it returns and before the request is written, which is
      // where the route's two transactions are apart.
      const context = await app.auth.$context;
      const verify = context.password.verify;
      let resetDuringTheRequest = false;
      context.password.verify = async (data) => {
        const verified = await verify(data);
        if (!resetDuringTheRequest) {
          resetDuringTheRequest = true;
          await resetPassword(victim, 'the victim chose this one');
        }
        return verified;
      };

      let answered: Awaited<ReturnType<typeof requestChange>>;
      try {
        answered = await requestChange(cookie, { newEmail: attacker, currentPassword: victim.password });
      } finally {
        context.password.verify = verify;
      }

      expect(resetDuringTheRequest).toBe(true);
      expect(answered.status).toBe(403);
      expect(answered.body.error?.code).toBe('INVALID_PASSWORD');
      expect(await requestsOf(victim.id)).toEqual([]);
      expect((await sentTo(victim.email)).filter((message) => message.template === 'email-change-requested')).toHaveLength(noticesBefore);
      expect((await operate('list')).stdout).not.toContain(attacker);
      expect(await emailOf(victim.id)).toBe(victim.email);
      expect((await login(victim.email, 'the victim chose this one')).status).toBe(200);
    });

    it('still refuses an approved link when the credential moved by a path that did not close the request', async () => {
      const victim = await makeUser('credential-behind-hook');
      const token = await askAndApprove(victim, newAddress('behind-hook-new'));
      const cookie = await loginCookie(victim);
      await changeCredentialBehindTheHook(victim.id);

      const confirmed = await confirmLink(token);

      expect(confirmed.status).toBe(400);
      expect(confirmed.body.error?.code).toBe('INVALID_LINK');
      expect(await emailOf(victim.id)).toBe(victim.email);
      expect(await sessionStatus(cookie)).toBe(200);
      expect(await requestsOf(victim.id)).toEqual([expect.objectContaining({ status: 'approved' })]);
    });

    it('makes the operation refuse to approve a request made under a credential that moved, say so, and close it', async () => {
      const victim = await makeUser('approve-after-credential');
      await requestChange(await loginCookie(victim), { newEmail: newAddress('approve-after-new'), currentPassword: victim.password });
      const row = await requestRow(victim.id);
      await changeCredentialBehindTheHook(victim.id);
      const mailedBefore = mailed.length;

      const approval = await operate('approve', '--request-id', row.id);

      expect(approval.code).toBe(1);
      expect(approval.stderr).toContain('password changed');
      expect(mailed).toHaveLength(mailedBefore);
      expect(await requestsOf(victim.id)).toEqual([expect.objectContaining({ status: 'superseded' })]);
      expect((await requestRow(victim.id)).token_hash).toBeNull();
    });
  });

  describe('the swap of an agency owner needs the holder confirmed', () => {
    it('refuses a link whose account became an owner after the approval, and works again once the operation confirms the holder', async () => {
      const user = await makeUser('became-owner');
      const address = newAddress('became-owner-new');
      const staleToken = await askAndApprove(user, address);
      await createAgency(user.id);

      const refused = await confirmLink(staleToken);

      expect(refused.status).toBe(400);
      expect(refused.body.error?.code).toBe('INVALID_LINK');
      expect(await emailOf(user.id)).toBe(user.email);

      const row = await requestRow(user.id);
      const mailedBefore = mailed.length;
      const withoutConfirmation = await operate('approve', '--request-id', row.id);
      expect(withoutConfirmation.code).toBe(1);
      expect(withoutConfirmation.stderr).toContain('--ownership-confirmed');
      expect(mailed).toHaveLength(mailedBefore);

      expect((await operate('approve', '--request-id', row.id, '--ownership-confirmed')).code).toBe(0);
      const freshToken = tokenOf(mailed[mailed.length - 1]);
      expect((await confirmLink(staleToken)).status).toBe(400);
      expect((await confirmLink(freshToken)).status).toBe(200);
      expect(await emailOf(user.id)).toBe(address);
    });
  });

  describe('the operation', () => {
    it('lists the open requests with what it needs to decide', async () => {
      const user = await makeUser('listed');
      const cookie = await loginCookie(user);
      const address = newAddress('listed-new');
      await requestChange(cookie, { newEmail: address, currentPassword: user.password });
      const row = await requestRow(user.id);

      const listed = JSON.parse((await operate('list')).stdout) as Record<string, unknown>[];

      expect(listed.find((entry) => entry.requestId === row.id)).toEqual({
        requestId: row.id,
        status: 'pending',
        requestedAt: new Date(row.requested_at).toISOString(),
        userId: user.id,
        currentEmail: user.email,
        newEmail: address,
        newEmailInUse: false,
        isAgencyOwner: false,
        linkExpiresAt: null
      });
    });

    it('approves an account that owns an agency only with the ownership confirmed outside the product', async () => {
      const holder = await makeUser('owner-account', { agencyOwner: true });
      const cookie = await loginCookie(holder);
      const address = newAddress('owner-new');
      await requestChange(cookie, { newEmail: address, currentPassword: holder.password });
      const row = await requestRow(holder.id);
      const mailedBefore = mailed.length;

      const refused = await operate('approve', '--request-id', row.id);

      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('--ownership-confirmed');
      expect(mailed).toHaveLength(mailedBefore);
      expect(await requestsOf(holder.id)).toEqual([expect.objectContaining({ status: 'pending', ownership_confirmed_at: null })]);
      const listed = JSON.parse((await operate('list')).stdout) as { requestId: string; isAgencyOwner: boolean }[];
      expect(listed.find((entry) => entry.requestId === row.id)?.isAgencyOwner).toBe(true);

      const approved = await operate('approve', '--request-id', row.id, '--ownership-confirmed');

      expect(approved.code, approved.stderr).toBe(0);
      expect(mailed).toHaveLength(mailedBefore + 1);
      expect(mailed[mailedBefore]?.to).toBe(address);
      const after = await requestsOf(holder.id);
      expect(after).toEqual([expect.objectContaining({ status: 'approved' })]);
      expect(after[0]?.ownership_confirmed_at).not.toBeNull();
    });

    it('does not ask a plain member for the ownership confirmation, and does not record one', async () => {
      const member = await makeUser('plain-member');
      await askAndApprove(member, newAddress('member-new'));

      expect((await requestsOf(member.id))[0]).toMatchObject({ status: 'approved', ownership_confirmed_at: null });
    });

    it('refuses to approve a request that is not open, an unknown one, and a request the account outgrew', async () => {
      const closed = await makeUser('closed');
      const cookie = await loginCookie(closed);
      await requestChange(cookie, { newEmail: newAddress('closed-new'), currentPassword: closed.password });
      const closedRow = await requestRow(closed.id);
      expect((await operate('reject', '--request-id', closedRow.id)).code).toBe(0);
      const mailedBefore = mailed.length;

      const rejected = await operate('approve', '--request-id', closedRow.id);
      const unknown = await operate('approve', '--request-id', randomUUID());
      const malformed = await operate('approve', '--request-id', 'not-a-uuid');
      const rejectedTwice = await operate('reject', '--request-id', closedRow.id);

      expect([rejected.code, unknown.code, malformed.code, rejectedTwice.code]).toEqual([1, 1, 1, 1]);
      expect(rejected.stderr).toContain('rejected');
      expect(unknown.stderr).toContain('not found');
      expect(mailed).toHaveLength(mailedBefore);

      const outgrown = await makeUser('outgrown');
      await requestChange(await loginCookie(outgrown), { newEmail: newAddress('outgrown-new'), currentPassword: outgrown.password });
      const outgrownRow = await requestRow(outgrown.id);
      await owner.knex('auth.user').where({ id: outgrown.id }).update({ email: newAddress('already-changed') });
      const stale = await operate('approve', '--request-id', outgrownRow.id);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain('changed its e-mail');
      expect((await requestRow(outgrown.id)).status).toBe('superseded');
      expect(mailed).toHaveLength(mailedBefore);
    });

    it('issues a link that lasts 48 hours and answers the operation with its expiry', async () => {
      const user = await makeUser('ttl');
      await requestChange(await loginCookie(user), { newEmail: newAddress('ttl-new'), currentPassword: user.password });
      const row = await requestRow(user.id);
      const approvedAt = Date.now();

      const approved = await operate('approve', '--request-id', row.id);

      const { requestId, linkExpiresAt } = JSON.parse(approved.stdout) as { requestId: string; linkExpiresAt: string };
      expect(requestId).toBe(row.id);
      const hours = (new Date(linkExpiresAt).getTime() - approvedAt) / 3_600_000;
      expect(hours).toBeGreaterThan(47.9);
      expect(hours).toBeLessThan(48.1);
      expect(new Date((await requestRow(user.id)).token_expires_at).toISOString()).toBe(linkExpiresAt);
    });

    it('records each decision in the audit trail', async () => {
      const user = await makeUser('audited');
      const token = await askAndApprove(user, newAddress('audited-new'));
      const row = await requestRow(user.id);
      expect((await confirmLink(token)).status).toBe(200);

      const events = await owner.knex('audit.events').where({ target_id: row.id }).orderBy('id').select('action', 'actor_user_id');

      expect(events).toEqual([
        { action: 'email_change.requested', actor_user_id: user.id },
        { action: 'email_change.approved', actor_user_id: null },
        { action: 'email_change.completed', actor_user_id: user.id }
      ]);
    });
  });
});
