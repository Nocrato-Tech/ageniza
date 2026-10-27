import { createHash, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #724 (security review of PR #722, finding 4): an account never confirmed is deleted 7 days after it was created,
// with its confirmations and acceptances, and only if it has no tie at all. The instant is a parameter, so nothing here depends on
// the clock of the test: every case passes the `p_at` it means. The worker is `ageniza_app` with no user bound to the transaction.
// The database is shared with the other suites, so every assertion is about the accounts this file made.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const DAY_MS = 86_400_000;
const REQUEST_ID = 'job:accounts.purge-unconfirmed';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId = '';
const createdUsers: string[] = [];
const createdAgencies: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

/** The instant the cases run at. It is the real now, so the accounts of the other suites (made a moment ago) are never due at it. */
const NOW = new Date();
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

interface AccountOptions {
  readonly emailVerified?: boolean;
  readonly createdAt?: Date;
  readonly name?: string;
}

const newUser = async (options: AccountOptions = {}): Promise<string> => {
  const id = randomUUID();
  createdUsers.push(id);
  await getOwner().knex('auth.user').insert({
    id,
    name: options.name ?? 'Typed by a third party',
    email: `purge-${id}@example.test`,
    emailVerified: options.emailVerified ?? false,
    createdAt: options.createdAt ?? ago(8)
  });
  return id;
};

/** An unconfirmed account the job should delete: 8 days old, with a confirmation link and the acceptance made at sign-up. */
const abandoned = async (options: AccountOptions = {}): Promise<string> => {
  const id = await newUser(options);
  const knex = getOwner().knex;
  await knex('auth.account').insert({ id: randomUUID(), accountId: id, providerId: 'credential', userId: id, password: `hash-${id}`, updatedAt: new Date() });
  await knex('email_confirmations').insert({ user_id: id, token_hash: createHash('sha256').update(id).digest('hex'), expires_at: ago(7) });
  await knex('legal_acceptances').insert({ user_id: id, document: 'terms', version: '2026-01-01' });
  return id;
};

const session = (userId: string, expiresAt: Date) =>
  getOwner().knex('auth.session').insert({ id: randomUUID(), token: `token-${randomUUID()}`, userId, expiresAt, createdAt: ago(8), updatedAt: ago(8) });

const agency = async (ownerUserId: string | null = null): Promise<string> => {
  const id = randomUUID();
  createdAgencies.push(id);
  await getOwner().knex('agencies').insert({ id, name: `Purge ${id}`, status: 'active', owner_user_id: ownerUserId });
  return id;
};

const exists = async (userId: string): Promise<boolean> => (await getOwner().knex('auth.user').where({ id: userId }).first('id')) !== undefined;

const purge = async (at: Date = NOW, limit = 500): Promise<number> => {
  const { rows } = await raw<{ rows: readonly { purged: number }[] }>(getApplication().knex, 'select app_private.purge_unconfirmed_accounts(?::timestamptz, ?::integer) as purged', [at, limit]);
  return rows[0]!.purged;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const admin = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'admin' }).first<{ id: string }>('id');
  if (admin === undefined) throw new Error('The system admin role is missing.');
  adminRoleId = admin.id;
});

afterAll(async () => {
  const knex = getOwner().knex;
  await knex('audit.events').where({ action: 'account.unconfirmed_purged' }).whereIn('target_id', createdUsers).delete();
  await knex('invitations').whereIn('agency_id', createdAgencies).delete();
  await knex('client_memberships').whereIn('user_id', createdUsers).delete();
  await knex('agency_memberships').whereIn('user_id', createdUsers).delete();
  await knex('clients').whereIn('agency_id', createdAgencies).delete();
  await knex('agencies').whereIn('id', createdAgencies).delete();
  await knex('legal_acceptances').whereIn('user_id', createdUsers).delete();
  await knex('auth.user').whereIn('id', createdUsers).delete();
  await application?.close();
  await owner?.close();
});

describe('app_private.purge_unconfirmed_accounts: what is deleted', () => {
  it('deletes an account never confirmed, 8 days old, with its confirmations, acceptances and credential', async () => {
    const id = await abandoned();
    const knex = getOwner().knex;
    await knex('legal_acceptances').insert({ user_id: id, document: 'privacy', version: '2026-01-01', revoked_at: ago(7) });
    await knex('auth.verification').insert({ id: randomUUID(), identifier: `reset-password:${randomUUID()}`, value: id, expiresAt: ago(-1), createdAt: ago(8), updatedAt: ago(8) });

    await expect(purge()).resolves.toBeGreaterThanOrEqual(1);

    expect(await exists(id)).toBe(false);
    expect(await knex('email_confirmations').where({ user_id: id })).toHaveLength(0);
    expect(await knex('legal_acceptances').where({ user_id: id })).toHaveLength(0);
    expect(await knex('auth.account').where({ userId: id })).toHaveLength(0);
    expect(await knex('auth.verification').where({ value: id })).toHaveLength(0);
  });

  it('writes the audit with the id of the account and nothing of the e-mail or the name', async () => {
    const id = await abandoned({ name: 'Nome do Atacante' });
    const email = (await getOwner().knex('auth.user').where({ id }).first<{ email: string }>('email')).email;

    await purge();

    const events = await getOwner().knex('audit.events').where({ action: 'account.unconfirmed_purged', target_id: id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: null, agency_id: null, target_type: 'user', request_id: REQUEST_ID });
    const text = JSON.stringify(events);
    expect(text).not.toContain(email);
    expect(text).not.toContain(email.split('@')[0]);
    expect(text).not.toContain('Nome do Atacante');
  });

  it('never deletes a confirmed account, however old', async () => {
    const id = await newUser({ emailVerified: true, createdAt: ago(400) });
    await purge();
    expect(await exists(id)).toBe(true);
  });

  it('keeps an account younger than 7 days and deletes one older, whichever side of the boundary a minute puts it', async () => {
    const justUnder = await newUser({ createdAt: new Date(ago(7).getTime() + 60_000) });
    const justOver = await newUser({ createdAt: new Date(ago(7).getTime() - 60_000) });
    const fresh = await newUser({ createdAt: ago(0) });

    await purge();

    expect(await exists(justUnder)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(justOver)).toBe(false);
  });

  it('keeps the period in one function, 7 days', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ period: string }> }>('select app_private.unconfirmed_account_retention()::text as period');
    expect(rows[0]?.period).toBe('7 days');
  });

  it('reads the age at the instant it is given, not at the clock', async () => {
    const id = await newUser({ createdAt: ago(8) });

    await purge(ago(2));
    expect(await exists(id)).toBe(true);

    await purge(NOW);
    expect(await exists(id)).toBe(false);
  });

  it('deletes at most the limit, the oldest first', async () => {
    await purge();
    const oldest = await newUser({ createdAt: ago(3000) });
    const newer = await newUser({ createdAt: ago(2999) });

    await expect(purge(NOW, 1)).resolves.toBe(1);

    expect(await exists(oldest)).toBe(false);
    expect(await exists(newer)).toBe(true);
  });
});

describe('app_private.purge_unconfirmed_accounts: an account with a tie is never deleted', () => {
  const ties: ReadonlyArray<readonly [string, (userId: string) => Promise<unknown>]> = [
    ['an agency of its own', (userId) => agency(userId)],
    ['an agency membership', async (userId) => getOwner().knex('agency_memberships').insert({ agency_id: await agency(), user_id: userId, role_id: adminRoleId, status: 'active' })],
    ['a client membership', async (userId) => {
      const agencyId = await agency();
      const clientId = randomUUID();
      await getOwner().knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Purge ${clientId}`, status: 'active' });
      return getOwner().knex('client_memberships').insert({ client_id: clientId, user_id: userId, status: 'active' });
    }],
    ['an invitation it accepted', async (userId) => getOwner().knex('invitations').insert({
      agency_id: await agency(), purpose: 'collaborator_invite', email: `purge-${randomUUID()}@example.test`, role_id: adminRoleId,
      token_hash: createHash('sha256').update(randomUUID()).digest('hex'), expires_at: ago(-1), used_at: ago(8), accepted_by_user_id: userId
    })],
    ['an invitation it sent', async (userId) => getOwner().knex('invitations').insert({
      agency_id: await agency(), purpose: 'collaborator_invite', email: `purge-${randomUUID()}@example.test`, role_id: adminRoleId,
      token_hash: createHash('sha256').update(randomUUID()).digest('hex'), expires_at: ago(-1), invited_by_user_id: userId
    })],
    ['a live session', (userId) => session(userId, new Date(NOW.getTime() + 3_600_000))],
    ['a row of the business that points to it (clients.updated_by)', async (userId) => {
      const clientId = randomUUID();
      await getOwner().knex('clients').insert({ id: clientId, agency_id: await agency(), name: `Purge ${clientId}`, status: 'active', updated_by: userId });
    }]
  ];

  it.each(ties)('keeps an unconfirmed account that has %s, and still deletes the one next to it', async (_name, tie) => {
    const tied = await abandoned();
    await tie(tied);
    const alone = await abandoned();

    await expect(purge()).resolves.toBeGreaterThanOrEqual(1);

    expect(await exists(tied)).toBe(true);
    expect(await getOwner().knex('email_confirmations').where({ user_id: tied })).toHaveLength(1);
    expect(await getOwner().knex('legal_acceptances').where({ user_id: tied })).toHaveLength(1);
    expect(await exists(alone)).toBe(false);
  });

  it('keeps the account an invitation created, which has its link even though it never confirmed', async () => {
    const id = await abandoned({ createdAt: ago(30) });
    await getOwner().knex('agency_memberships').insert({ agency_id: await agency(), user_id: id, role_id: adminRoleId, status: 'active' });
    await purge();
    expect(await exists(id)).toBe(true);
  });

  it('does not count a session that already expired at the instant of the run', async () => {
    const id = await abandoned();
    await session(id, new Date(NOW.getTime() - 3_600_000));

    await purge();

    expect(await exists(id)).toBe(false);
    expect(await getOwner().knex('auth.session').where({ userId: id })).toHaveLength(0);
  });

  it('reads a session against the instant it is given: it is live at one and expired at another', async () => {
    const id = await abandoned();
    await session(id, new Date(NOW.getTime() + 3 * DAY_MS));

    await purge(new Date(NOW.getTime() + DAY_MS));
    expect(await exists(id)).toBe(true);

    await purge(new Date(NOW.getTime() + 4 * DAY_MS));
    expect(await exists(id)).toBe(false);
  });
});

describe('app_private.purge_unconfirmed_accounts: a tie that lands while it runs', () => {
  // A membership has a foreign key, which refuses the delete by itself; a session goes away with the account in cascade, so only the
  // lock on the account and the second reading of its ties keep a session that was just opened.
  it.each([
    ['an agency membership', async (holder: Knex.Transaction, userId: string) => holder('agency_memberships').insert({ agency_id: await agency(), user_id: userId, role_id: adminRoleId, status: 'active' })],
    ['a session', async (holder: Knex.Transaction, userId: string) => holder('auth.session').insert({ id: randomUUID(), token: `token-${randomUUID()}`, userId, expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date() })]
  ])('waits for the transaction that is giving the account %s, and then keeps the account', async (_name, tie) => {
    const id = await abandoned();
    const other = await abandoned();
    const holder = await getOwner().knex.transaction();
    try {
      await tie(holder, id);

      const running = purge();
      let blocked = false;
      for (let attempt = 0; attempt < 60 && !blocked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { rows } = await getOwner().knex.raw<{ rows: Array<{ waiting: number }> }>(
          `select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and query like '%purge_unconfirmed_accounts%' and pid <> pg_backend_pid()`
        );
        blocked = (rows[0]?.waiting ?? 0) > 0;
      }
      expect(blocked).toBe(true);

      await holder.commit();
      await expect(running).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }

    expect(await exists(id)).toBe(true);
    expect(await exists(other)).toBe(false);
  });
});

describe('app_private.purge_unconfirmed_accounts: who may call it, and how', () => {
  it('refuses a request, which has a user bound to the transaction, and deletes nothing', async () => {
    const victim = await abandoned();
    const caller = await newUser({ emailVerified: true });

    await expect(withAuthenticatedUserTransaction(
      getApplication(), createVerifiedUserClaims({ userId: caller }),
      (transaction) => transaction.raw('select app_private.purge_unconfirmed_accounts(?::timestamptz, 500)', [NOW])
    )).rejects.toMatchObject({ code: '42501' });

    expect(await exists(victim)).toBe(true);
  });

  it('is open to the application role and closed to PUBLIC', async () => {
    const { rows } = await getOwner().knex.raw<{ rows: Array<{ app: boolean; public_acl: boolean; tie_app: boolean; tie_public: boolean }> }>(`
      select
        has_function_privilege('ageniza_app', 'app_private.purge_unconfirmed_accounts(timestamptz, integer)', 'execute') as app,
        coalesce((select bool_or(acl.grantee = 0) from pg_proc p, aclexplode(p.proacl) acl
          where p.oid = 'app_private.purge_unconfirmed_accounts(timestamptz, integer)'::regprocedure), false) as public_acl,
        has_function_privilege('ageniza_app', 'app_private.unconfirmed_account_has_ties(uuid, timestamptz)', 'execute') as tie_app,
        coalesce((select bool_or(acl.grantee = 0) from pg_proc p, aclexplode(p.proacl) acl
          where p.oid = 'app_private.unconfirmed_account_has_ties(uuid, timestamptz)'::regprocedure), false) as tie_public
    `);
    expect(rows[0]).toEqual({ app: true, public_acl: false, tie_app: false, tie_public: false });
  });

  it.each([
    ['no instant', 'null::timestamptz, 10'],
    ['no limit', 'now(), null::integer'],
    ['a limit of zero', 'now(), 0'],
    ['a limit above 500', 'now(), 501']
  ])('refuses %s', async (_name, args) => {
    await expect(raw(getApplication().knex, `select app_private.purge_unconfirmed_accounts(${args})`, [])).rejects.toMatchObject({ code: '22023' });
  });

  it('runs one at a time: a run that finds another in progress deletes nothing and answers 0', async () => {
    const id = await abandoned();
    const holder = await getOwner().knex.transaction();
    try {
      await holder.raw(`select pg_advisory_xact_lock(hashtextextended('app_private.purge_unconfirmed_accounts', 0))`);

      await expect(purge()).resolves.toBe(0);
      expect(await exists(id)).toBe(true);
    } finally {
      await holder.rollback();
    }

    await purge();
    expect(await exists(id)).toBe(false);
  });
});

describe('the password reset that takes over an unconfirmed account (issue #724)', () => {
  const reset = async (userId: string): Promise<boolean> =>
    (await raw<{ rows: readonly { taken: boolean }[] }>(getApplication().knex, 'select app_private.confirm_email_by_password_reset(?::uuid) as taken', [userId])).rows[0]!.taken;
  const nameOf = async (userId: string): Promise<string> => (await getOwner().knex('auth.user').where({ id: userId }).first<{ name: string }>('name')).name;

  const localPartOf = async (userId: string): Promise<string> =>
    (await getOwner().knex('auth.user').where({ id: userId }).first<{ email: string }>('email')).email.split('@')[0]!;

  it('does not keep the name the third party typed: it becomes the part of the address before the @, never empty', async () => {
    const id = await abandoned({ createdAt: ago(1), name: 'Nome do Atacante' });

    await expect(reset(id)).resolves.toBe(true);

    expect(await nameOf(id)).toBe(await localPartOf(id));
    expect(await nameOf(id)).toMatch(/^purge-[0-9a-f-]{36}$/);
    expect((await getOwner().knex('auth.user').where({ id }).first<{ emailVerified: boolean }>('emailVerified')).emailVerified).toBe(true);
  });

  it('leaves the name of a confirmed account alone', async () => {
    const id = await newUser({ emailVerified: true, name: 'Pessoa Real' });

    await expect(reset(id)).resolves.toBe(false);

    expect(await nameOf(id)).toBe('Pessoa Real');
  });

  it('is not deleted afterwards: the account taken over is confirmed', async () => {
    const id = await abandoned({ name: 'Nome do Atacante' });
    await reset(id);
    await purge();
    expect(await exists(id)).toBe(true);
  });
});
