import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  backendPid,
  createVerifiedUserClaims,
  raw,
  resolveIntegrationDatabaseUrls,
  waitForBackendsBlockedBy,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #706, and the security review of PR #721: the confirmation link is ours and has state. Only
// the hash of a random token is stored, it works once, a new one voids the previous ones, the reset
// voids them all, and consuming it needs the credential the caller verified the password against.
// Everything that consumes or issues runs as ageniza_app, through the functions.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
const createdUsers: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');

const newAccount = async (emailVerified = false): Promise<{ id: string; credential: string }> => {
  const id = randomUUID();
  const credential = `hash-${randomUUID()}`;
  createdUsers.push(id);
  await getOwner().knex('auth.user').insert({ id, name: 'Confirmação', email: `confirm-${id}@example.test`, emailVerified });
  await getOwner().knex('auth.account').insert({ id: randomUUID(), accountId: id, providerId: 'credential', userId: id, password: credential, updatedAt: new Date() });
  return { id, credential };
};

const issue = async (userId: string, token: string): Promise<boolean> => {
  const result = await raw<{ rows: readonly { issued: boolean }[] }>(getApplication().knex, 'select app_private.issue_email_confirmation(?::uuid, ?) as issued', [userId, hashOf(token)]);
  return result.rows[0]?.issued ?? false;
};
const consume = async (token: string, credential: string): Promise<string | null> => {
  const result = await raw<{ rows: readonly { user_id: string | null }[] }>(getApplication().knex, 'select app_private.consume_email_confirmation(?, ?) as user_id', [hashOf(token), credential]);
  return result.rows[0]?.user_id ?? null;
};
const lookup = async (token: string): Promise<readonly { user_id: string }[]> =>
  (await raw<{ rows: readonly { user_id: string }[] }>(getApplication().knex, 'select user_id from app_private.email_confirmation_by_token_hash(?)', [hashOf(token)])).rows;
const isVerified = async (userId: string): Promise<boolean> =>
  (await getOwner().knex('auth.user').where({ id: userId }).first('emailVerified')).emailVerified as boolean;
const unconsumedOf = (userId: string) => getOwner().knex('email_confirmations').where({ user_id: userId }).whereNull('consumed_at').select('token_hash');

beforeAll(() => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await getOwner().knex('auth.user').whereIn('id', createdUsers).delete();
  await application?.close();
  await owner?.close();
});

describe('public.email_confirmations (issue #706, security review of PR #721)', () => {
  it('stores only the hash of the token, for 24 hours, and nothing of the e-mail', async () => {
    const account = await newAccount();
    const token = newToken();

    await expect(issue(account.id, token)).resolves.toBe(true);

    const rows = await getOwner().knex('email_confirmations').where({ user_id: account.id })
      .select('token_hash', getOwner().knex.raw('extract(epoch from (expires_at - created_at)) / 3600 as hours'));
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashOf(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(Number(rows[0].hours)).toBeCloseTo(24, 3);
    await expect(lookup(token)).resolves.toEqual([{ user_id: account.id }]);
  });

  it('confirms with the verified credential, and the link works once', async () => {
    const account = await newAccount();
    const token = newToken();
    await issue(account.id, token);

    await expect(consume(token, account.credential)).resolves.toBe(account.id);
    expect(await isVerified(account.id)).toBe(true);

    // Even if the account were unconfirmed again, the consumed link stays dead.
    await getOwner().knex('auth.user').where({ id: account.id }).update({ emailVerified: false });
    await expect(lookup(token)).resolves.toEqual([]);
    await expect(consume(token, account.credential)).resolves.toBeNull();
    expect(await isVerified(account.id)).toBe(false);
  });

  it('refuses a credential that is not the account\'s, an expired link and an unknown one, changing nothing', async () => {
    const account = await newAccount();
    const token = newToken();
    await issue(account.id, token);

    await expect(consume(token, 'hash-of-another-credential')).resolves.toBeNull();
    await expect(consume(newToken(), account.credential)).resolves.toBeNull();
    await getOwner().knex('email_confirmations').where({ token_hash: hashOf(token) }).update({ expires_at: getOwner().knex.raw("now() - interval '1 second'") });
    await expect(lookup(token)).resolves.toEqual([]);
    await expect(consume(token, account.credential)).resolves.toBeNull();
    expect(await isVerified(account.id)).toBe(false);
  });

  it('a new link voids the previous one, and a confirmed account gets none', async () => {
    const account = await newAccount();
    const first = newToken();
    const second = newToken();
    await issue(account.id, first);
    await issue(account.id, second);

    await expect(unconsumedOf(account.id)).resolves.toEqual([{ token_hash: hashOf(second) }]);
    await expect(consume(first, account.credential)).resolves.toBeNull();
    await expect(consume(second, account.credential)).resolves.toBe(account.id);

    const confirmed = await newAccount(true);
    await expect(issue(confirmed.id, newToken())).resolves.toBe(false);
    await expect(unconsumedOf(confirmed.id)).resolves.toEqual([]);
  });

  it('the password reset voids every link of the account', async () => {
    const account = await newAccount();
    const token = newToken();
    await issue(account.id, token);

    await raw(getApplication().knex, 'select app_private.confirm_email_by_password_reset(?::uuid)', [account.id]);

    await expect(unconsumedOf(account.id)).resolves.toEqual([]);
    await getOwner().knex('auth.user').where({ id: account.id }).update({ emailVerified: false });
    await expect(consume(token, account.credential)).resolves.toBeNull();
  });

  it('waits for a password change in flight and then refuses the old credential (security review of PR #722)', async () => {
    const account = await newAccount();
    const token = newToken();
    await issue(account.id, token);

    const reset = await getOwner().knex.transaction();
    try {
      const updated = await raw<{ rowCount: number }>(reset, `update auth.account set password = 'hash-after-the-reset' where "userId" = ?::uuid and "providerId" = 'credential'`, [account.id]);
      expect(updated.rowCount).toBe(1);

      const resetPid = await backendPid(reset);
      const consuming = consume(token, account.credential);
      await waitForBackendsBlockedBy(getOwner().knex, resetPid, { blockedStatement: '%consume_email_confirmation%' });

      await reset.commit();
      await expect(consuming).resolves.toBeNull();
    } finally {
      if (!reset.isCompleted()) await reset.rollback();
    }
    expect(await isVerified(account.id)).toBe(false);
    await expect(unconsumedOf(account.id)).resolves.toEqual([{ token_hash: hashOf(token) }]);
  });

  it('is out of reach of the application role except through the functions', async () => {
    const account = await newAccount();
    const denied = { code: '42501' };
    const asUser = <T>(work: Parameters<typeof withAuthenticatedUserTransaction<T>>[2]) =>
      withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId: account.id }), work);

    await expect(asUser((transaction) => transaction('email_confirmations').select('id'))).rejects.toMatchObject(denied);
    await expect(asUser((transaction) => transaction('email_confirmations').insert({
      user_id: account.id, token_hash: hashOf(newToken()), expires_at: new Date(Date.now() + 60_000)
    }))).rejects.toMatchObject(denied);

    const { rows } = await raw<{ rows: readonly Record<string, boolean>[] }>(getOwner().knex, `
      select
        c.relrowsecurity as rls,
        c.relforcerowsecurity as forced,
        has_any_column_privilege('ageniza_app', 'public.email_confirmations', 'select') as can_select,
        has_function_privilege('ageniza_app', 'app_private.issue_email_confirmation(uuid, text)', 'execute') as can_issue,
        has_function_privilege('ageniza_app', 'app_private.consume_email_confirmation(text, text)', 'execute') as can_consume
      from pg_catalog.pg_class c where c.oid = 'public.email_confirmations'::regclass
    `, []);
    expect(rows[0]).toEqual({ rls: true, forced: true, can_select: false, can_issue: true, can_consume: true });
  });
});
