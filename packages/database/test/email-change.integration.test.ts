import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #80. The two functions below are the only paths through which the application role
// touches `public.email_change_requests`; approving, rejecting and listing belong to the CLI, which
// connects as the owner. Everything here runs as ageniza_app unless it says "owner".
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(
  userId: string,
  work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]
): Promise<TResult> => withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@email-change.test`;

const createdUsers: string[] = [];

const insertUser = async (label: string): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  const email = unique(label);
  await getOwner().knex('auth.user').insert({ id, name: label, email, emailVerified: false });
  createdUsers.push(id);
  return { id, email };
};

const insertSession = async (userId: string): Promise<void> => {
  await getOwner().knex('auth.session').insert({
    id: randomUUID(), token: randomUUID(), userId, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date()
  });
};

const request = (userId: string, newEmail: string | null): Promise<{ request_id: string; previous_email: string }[]> =>
  asUser(userId, async (transaction) => (await raw<{ rows: { request_id: string; previous_email: string }[] }>(
    transaction, 'select * from app_private.request_email_change(?)', [newEmail]
  )).rows);

const confirm = (tokenHash: string | null): Promise<{ account_id: string; previous_email: string; next_email: string }[]> =>
  getApplication().transaction(async (transaction) => (await raw<{ rows: { account_id: string; previous_email: string; next_email: string }[] }>(
    transaction, 'select * from app_private.confirm_email_change(?)', [tokenHash]
  )).rows);

interface Seeded { readonly id: string; readonly tokenHash: string }

/** What the CLI leaves behind on approval, written as the owner. */
const seedApproved = async (
  user: { id: string; email: string },
  newEmail: string,
  overrides: { status?: string; expiresInMs?: number; oldEmail?: string; withToken?: boolean; ownershipConfirmed?: boolean } = {}
): Promise<Seeded> => {
  const id = randomUUID();
  const tokenHash = `hash-${randomUUID()}`;
  const status = overrides.status ?? 'approved';
  const withToken = status === 'approved';
  await getOwner().knex('email_change_requests').insert({
    id,
    user_id: user.id,
    old_email: overrides.oldEmail ?? user.email,
    new_email: newEmail,
    status,
    token_hash: withToken ? tokenHash : null,
    token_expires_at: withToken ? new Date(Date.now() + (overrides.expiresInMs ?? 3_600_000)) : null,
    credential_fingerprint: await fingerprintOf(user.id),
    ownership_confirmed_at: overrides.ownershipConfirmed === true ? new Date() : null
  });
  return { id, tokenHash };
};

const createdAgencies: string[] = [];

const insertCredential = async (userId: string, password = `hash-${randomUUID()}`): Promise<string> => {
  await getOwner().knex('auth.account').insert({
    id: randomUUID(), accountId: userId, providerId: 'credential', userId, password, updatedAt: new Date()
  });
  return password;
};

/** What a password reset does to the credential: a new salted hash replaces the old one. */
const changeCredential = async (userId: string): Promise<void> => {
  await getOwner().knex('auth.account').where({ userId, providerId: 'credential' }).update({ password: `hash-${randomUUID()}`, updatedAt: new Date() });
};

const makeOwner = async (userId: string): Promise<void> => {
  const id = randomUUID();
  await getOwner().knex('agencies').insert({ id, name: `Agency ${id.slice(0, 8)}`, owner_user_id: userId });
  createdAgencies.push(id);
};

const fingerprintOf = async (userId: string): Promise<string | null> =>
  (await raw<{ rows: { fingerprint: string | null }[] }>(getOwner().knex, 'select app_private.credential_fingerprint(?::uuid) as fingerprint', [userId])).rows[0]?.fingerprint ?? null;

/** The password reset's side of barrier 1, as the application role runs it. */
const supersedeOpenRequests = (userId: string): Promise<number> =>
  getApplication().transaction(async (transaction) => (await raw<{ rows: { closed: number }[] }>(
    transaction, 'select app_private.supersede_email_change_requests(?::uuid) as closed', [userId]
  )).rows[0]?.closed ?? -1);

const emailOf = async (userId: string): Promise<string> =>
  (await getOwner().knex('auth.user').where({ id: userId }).first('email')).email;
const sessionsOf = async (userId: string): Promise<number> =>
  Number((await getOwner().knex('auth.session').where({ userId }).count('* as total'))[0]?.total);
const requestsOf = (userId: string) =>
  getOwner().knex('email_change_requests').where({ user_id: userId }).orderBy('requested_at').select('id', 'status', 'new_email', 'old_email', 'token_hash');

/**
 * Holds the row lock of one request in a real owner transaction until released, so the transactions
 * under test can be lined up behind it in a known order.
 */
const holdRequestLock = (requestId: string): { readonly locked: Promise<void>; release: () => void; readonly done: Promise<void> } => {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let markLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const done = getOwner().transaction(async (transaction) => {
    await raw(transaction, 'select id from public.email_change_requests where id = ? for update', [requestId]);
    markLocked();
    await released;
  });
  return { locked, release: () => release(), done };
};

/** Waits until a backend running a statement that matches the pattern is blocked on a lock. */
const waitUntilBlocked = async (statementPattern: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await raw<{ rows: { waiting: number }[] }>(getOwner().knex, `
      select count(*)::int as waiting
      from pg_catalog.pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike ?
    `, [statementPattern]);
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend running ${statementPattern} ever waited on a lock.`);
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  await getOwner().knex('audit.events').whereIn('actor_user_id', createdUsers).delete();
  await getOwner().knex('agencies').whereIn('id', createdAgencies).delete();
  await getOwner().knex('auth.user').whereIn('id', createdUsers).delete();
  await application?.close();
  await owner?.close();
});

describe('app_private.request_email_change (issue #80)', () => {
  it('records a pending request for the bound actor, with the address normalized and the old one captured', async () => {
    const user = await insertUser('requester');

    const rows = await request(user.id, '  New.Address@Email-Change.TEST ');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.previous_email).toBe(user.email);
    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({
      id: rows[0]?.request_id, status: 'pending', new_email: 'new.address@email-change.test', old_email: user.email, token_hash: null
    })]);
    const audit = await getOwner().knex('audit.events').where({ actor_user_id: user.id, action: 'email_change.requested' }).select('target_id');
    expect(audit).toEqual([{ target_id: rows[0]?.request_id }]);
  });

  it('keeps one open request per account: a new one supersedes the previous, approved or not', async () => {
    const user = await insertUser('superseder');
    const first = await request(user.id, unique('first'));
    const firstHash = `hash-${randomUUID()}`;
    await getOwner().knex('email_change_requests').where({ id: first[0]?.request_id }).update({
      status: 'approved', token_hash: firstHash, token_expires_at: new Date(Date.now() + 60_000)
    });

    const second = await request(user.id, unique('second'));
    const third = await request(user.id, unique('third'));

    const states = Object.fromEntries((await requestsOf(user.id)).map((row) => [row.id, { status: row.status, token: row.token_hash }]));
    expect(states[first[0]!.request_id]).toEqual({ status: 'superseded', token: null });
    expect(states[second[0]!.request_id]).toEqual({ status: 'superseded', token: null });
    expect(states[third[0]!.request_id]).toEqual({ status: 'pending', token: null });
    await expect(confirm(firstHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it('records a request for an address another account already uses, exactly like any other', async () => {
    const user = await insertUser('collider');
    const other = await insertUser('holder');

    const rows = await request(user.id, other.email.toUpperCase());

    expect(rows).toHaveLength(1);
    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'pending', new_email: other.email })]);
  });

  it('refuses a transaction with no actor, a malformed address and the address the account already has, recording nothing', async () => {
    const user = await insertUser('refused');
    const raw41 = ['', '   ', 'plain', 'a@b', 'a b@c.test', '<a>@b.test', 'a@b@c.test', `${'x'.repeat(320)}@c.test`];

    await expect(getApplication().transaction((transaction) =>
      raw(transaction, "select * from app_private.request_email_change('someone@email-change.test')", [])
    )).rejects.toMatchObject({ code: 'A0040' });
    await expect(getApplication().transaction(async (transaction) => {
      await raw(transaction, "select set_config('app.user_id', ?, true)", [user.id]);
      await raw(transaction, "select * from app_private.request_email_change('someone@email-change.test')", []);
    })).rejects.toMatchObject({ code: 'A0040' });
    for (const candidate of [null, ...raw41]) {
      await expect(request(user.id, candidate), String(candidate).slice(0, 30)).rejects.toMatchObject({ code: 'A0041' });
    }
    await expect(request(user.id, `  ${user.email.toUpperCase()} `)).rejects.toMatchObject({ code: 'A0043' });

    expect(await requestsOf(user.id)).toEqual([]);
  });

  it('gives the application role no privilege on the table: it cannot read, write or reset a request directly', async () => {
    const user = await insertUser('direct');
    const seeded = await seedApproved(user, unique('direct-new'));

    await expect(asUser(user.id, (transaction) => transaction('email_change_requests').select('id'))).rejects.toThrow(/permission denied/);
    await expect(asUser(user.id, (transaction) => transaction('email_change_requests').insert({
      user_id: user.id, old_email: user.email, new_email: unique('forged')
    }))).rejects.toThrow(/permission denied/);
    await expect(asUser(user.id, (transaction) => transaction('email_change_requests').where({ id: seeded.id }).update({ status: 'completed' }))).rejects.toThrow(/permission denied/);
    await expect(asUser(user.id, (transaction) => transaction('email_change_requests').where({ id: seeded.id }).delete())).rejects.toThrow(/permission denied/);

    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'approved' })]);
  });
});

describe('app_private.confirm_email_change (issue #80)', () => {
  it('swaps the address, ends every session and reset link, and spends the link', async () => {
    const user = await insertUser('swapper');
    const bystander = await insertUser('bystander');
    await insertSession(user.id);
    await insertSession(user.id);
    await insertSession(bystander.id);
    await getOwner().knex('auth.verification').insert({ id: randomUUID(), identifier: `reset-${randomUUID()}`, value: user.id, expiresAt: new Date(Date.now() + 60_000) });
    const bystanderReset = randomUUID();
    await getOwner().knex('auth.verification').insert({ id: randomUUID(), identifier: `reset-${bystanderReset}`, value: bystander.id, expiresAt: new Date(Date.now() + 60_000) });
    const newEmail = unique('swapped');
    const seeded = await seedApproved(user, newEmail);

    const rows = await confirm(seeded.tokenHash);

    expect(rows).toEqual([{ account_id: user.id, previous_email: user.email, next_email: newEmail }]);
    expect(await emailOf(user.id)).toBe(newEmail);
    expect((await getOwner().knex('auth.user').where({ id: user.id }).first('emailVerified')).emailVerified).toBe(true);
    expect(await sessionsOf(user.id)).toBe(0);
    expect(await sessionsOf(bystander.id)).toBe(1);
    expect(await getOwner().knex('auth.verification').where({ value: user.id }).count('* as total')).toEqual([{ total: '0' }]);
    expect(await getOwner().knex('auth.verification').where({ identifier: `reset-${bystanderReset}` }).count('* as total')).toEqual([{ total: '1' }]);
    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'completed', token_hash: null })]);
    expect(await getOwner().knex('audit.events').where({ actor_user_id: user.id, action: 'email_change.completed', target_id: seeded.id }).count('* as total')).toEqual([{ total: '1' }]);

    await expect(confirm(seeded.tokenHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(user.id)).toBe(newEmail);
  });

  it('answers every link that cannot swap with the same error, and changes nothing', async () => {
    const holder = await insertUser('new-holder');
    const expiredOwner = await insertUser('expired');
    await insertSession(expiredOwner.id);
    const expired = await seedApproved(expiredOwner, unique('expired-new'), { expiresInMs: -1_000 });
    const taker = await insertUser('taker');
    await insertSession(taker.id);
    const takenAfterApproval = await seedApproved(taker, holder.email);
    const mismatch = await insertUser('mismatch');
    await insertSession(mismatch.id);
    const mismatched = await seedApproved(mismatch, unique('mismatch-new'), { oldEmail: unique('previous-address') });
    const pending = await insertUser('pending-only');
    const [pendingRequest] = await request(pending.id, unique('pending-new'));

    for (const hash of [null, '', 'no-such-hash', pendingRequest?.request_id ?? '', expired.tokenHash, takenAfterApproval.tokenHash, mismatched.tokenHash]) {
      await expect(confirm(hash), String(hash)).rejects.toMatchObject({ code: 'A0042' });
    }

    for (const user of [expiredOwner, taker, mismatch]) {
      expect(await emailOf(user.id), user.email).toBe(user.email);
      expect(await sessionsOf(user.id), user.email).toBe(1);
    }
    expect(await emailOf(holder.id)).toBe(holder.email);
    expect(await emailOf(pending.id)).toBe(pending.email);
    expect(await requestsOf(taker.id)).toEqual([expect.objectContaining({ status: 'approved' })]);
  });

  it('lets exactly one of two concurrent confirmations through', async () => {
    const user = await insertUser('racer');
    await insertSession(user.id);
    const newEmail = unique('raced');
    const seeded = await seedApproved(user, newEmail);

    const outcomes = await Promise.allSettled([confirm(seeded.tokenHash), confirm(seeded.tokenHash), confirm(seeded.tokenHash)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((entry) => entry.status === 'rejected')) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'A0042' });
    }
    expect(await emailOf(user.id)).toBe(newEmail);
    expect(await getOwner().knex('audit.events').where({ actor_user_id: user.id, action: 'email_change.completed' }).count('* as total')).toEqual([{ total: '1' }]);
  });

  it('does not deadlock with a request on the same account: the account is always locked before its requests', async () => {
    const user = await insertUser('lock-order');
    await insertSession(user.id);
    const newEmail = unique('lock-order-new');
    const approved = await seedApproved(user, newEmail);
    const holder = holdRequestLock(approved.id);
    await holder.locked;

    // The confirmation goes first and waits behind the holder; the request lines up after it. With
    // the account locked second by the confirmation, the two end up waiting on each other (40P01).
    const confirmation = confirm(approved.tokenHash);
    await waitUntilBlocked('%confirm_email_change%');
    const requested = request(user.id, unique('lock-order-next'));
    await waitUntilBlocked('%request_email_change%');
    holder.release();
    await holder.done;

    const outcomes = await Promise.allSettled([confirmation, requested]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await emailOf(user.id)).toBe(newEmail);
    expect((await requestsOf(user.id)).map((row) => row.status)).toEqual(['completed', 'pending']);
  });

  it('does not let a signup that took the address in the meantime be overwritten', async () => {
    const user = await insertUser('late-collision');
    const newEmail = unique('late-new');
    const seeded = await seedApproved(user, newEmail);
    await getOwner().knex('auth.user').insert({ id: randomUUID(), name: 'late', email: newEmail, emailVerified: true }).then(async () => {
      createdUsers.push((await getOwner().knex('auth.user').where({ email: newEmail }).first('id')).id);
    });

    await expect(confirm(seeded.tokenHash)).rejects.toMatchObject({ code: 'A0042' });

    expect(await emailOf(user.id)).toBe(user.email);
  });
});

describe('a request does not outlive the credential it was made under (issue #80, security review of PR #325)', () => {
  it('records a fingerprint of the credential, not the credential, and none for an account without one', async () => {
    const withPassword = await insertUser('fingerprinted');
    const password = await insertCredential(withPassword.id);
    const withoutPassword = await insertUser('no-credential');

    const [requested] = await request(withPassword.id, unique('fingerprint-new'));
    await request(withoutPassword.id, unique('no-credential-new'));

    const stored = await getOwner().knex('email_change_requests').where({ id: requested?.request_id }).first('credential_fingerprint');
    expect(stored.credential_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.credential_fingerprint).toBe(await fingerprintOf(withPassword.id));
    expect(stored.credential_fingerprint).not.toContain(password);
    expect((await getOwner().knex('email_change_requests').where({ user_id: withoutPassword.id }).first('credential_fingerprint')).credential_fingerprint).toBeNull();
  });

  it('closes the open requests of the account whose credential changed, kills their link and leaves the others alone', async () => {
    const victim = await insertUser('reset-victim');
    await insertCredential(victim.id);
    const bystander = await insertUser('reset-bystander');
    await insertCredential(bystander.id);
    await request(victim.id, unique('victim-new'));
    const approved = await seedApproved(bystander, unique('bystander-new'));
    const victimApproved = await insertUser('reset-victim-approved');
    await insertCredential(victimApproved.id);
    const approvedUnderOldCredential = await seedApproved(victimApproved, unique('victim-approved-new'));

    await changeCredential(victim.id);
    await changeCredential(victimApproved.id);

    expect(await supersedeOpenRequests(victim.id)).toBe(1);
    expect(await supersedeOpenRequests(victimApproved.id)).toBe(1);

    expect(await requestsOf(victim.id)).toEqual([expect.objectContaining({ status: 'superseded', token_hash: null })]);
    expect(await requestsOf(victimApproved.id)).toEqual([expect.objectContaining({ status: 'superseded', token_hash: null })]);
    await expect(confirm(approvedUnderOldCredential.tokenHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(victimApproved.id)).toBe(victimApproved.email);
    // A request made under a credential that did not move is not touched.
    expect(await requestsOf(bystander.id)).toEqual([expect.objectContaining({ id: approved.id, status: 'approved', token_hash: approved.tokenHash })]);
    expect(await getOwner().knex('audit.events').where({ actor_user_id: victim.id, action: 'email_change.superseded_by_credential' }).count('* as total')).toEqual([{ total: '1' }]);
  });

  it('closes nothing when the credential did not change, so calling it cancels no one', async () => {
    const user = await insertUser('unchanged');
    await insertCredential(user.id);
    const approved = await seedApproved(user, unique('unchanged-new'));

    expect(await supersedeOpenRequests(user.id)).toBe(0);
    expect(await supersedeOpenRequests(randomUUID())).toBe(0);

    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'approved', token_hash: approved.tokenHash })]);
    expect(await confirm(approved.tokenHash)).toHaveLength(1);
  });

  it('refuses the link on its own when the credential changed, even if nothing closed the request', async () => {
    const user = await insertUser('stale-credential');
    await insertCredential(user.id);
    await insertSession(user.id);
    const approved = await seedApproved(user, unique('stale-credential-new'));

    await changeCredential(user.id);

    await expect(confirm(approved.tokenHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(user.id)).toBe(user.email);
    expect(await sessionsOf(user.id)).toBe(1);
    expect(await requestsOf(user.id)).toEqual([expect.objectContaining({ status: 'approved', token_hash: approved.tokenHash })]);
  });

  it('refuses the link when the account had no credential at request time and has one now', async () => {
    const user = await insertUser('credential-appeared');
    const approved = await seedApproved(user, unique('credential-appeared-new'));
    await insertCredential(user.id);

    await expect(confirm(approved.tokenHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it('does not deadlock with a request on the same account: the account is locked before its requests', async () => {
    const user = await insertUser('supersede-lock-order');
    await insertCredential(user.id);
    const approved = await seedApproved(user, unique('supersede-lock-order-new'));
    await changeCredential(user.id);
    const holder = holdRequestLock(approved.id);
    await holder.locked;

    const superseding = supersedeOpenRequests(user.id);
    await waitUntilBlocked('%supersede_email_change_requests%');
    const requested = request(user.id, unique('supersede-lock-order-next'));
    await waitUntilBlocked('%request_email_change%');
    holder.release();
    await holder.done;

    const outcomes = await Promise.allSettled([superseding, requested]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await requestsOf(user.id)).map((row) => row.status)).toEqual(['superseded', 'pending']);
  });
});

describe('the swap of an agency owner needs the holder confirmed (issue #80, security review of PR #325)', () => {
  it('refuses the link of an account that became an owner after the approval, and keeps it for a second approval', async () => {
    const user = await insertUser('became-owner');
    await insertSession(user.id);
    const newEmail = unique('became-owner-new');
    const approved = await seedApproved(user, newEmail);
    await makeOwner(user.id);

    await expect(confirm(approved.tokenHash)).rejects.toMatchObject({ code: 'A0042' });
    expect(await emailOf(user.id)).toBe(user.email);
    expect(await sessionsOf(user.id)).toBe(1);

    await getOwner().knex('email_change_requests').where({ id: approved.id }).update({ ownership_confirmed_at: new Date() });
    expect(await confirm(approved.tokenHash)).toHaveLength(1);
    expect(await emailOf(user.id)).toBe(newEmail);
  });

  it('still swaps the address of an owner whose holder was confirmed at the approval, and of anyone who is not an owner', async () => {
    const owner = await insertUser('confirmed-owner');
    await makeOwner(owner.id);
    const confirmedRequest = await seedApproved(owner, unique('confirmed-owner-new'), { ownershipConfirmed: true });
    const member = await insertUser('plain-account');
    const plainRequest = await seedApproved(member, unique('plain-account-new'));

    expect(await confirm(confirmedRequest.tokenHash)).toHaveLength(1);
    expect(await confirm(plainRequest.tokenHash)).toHaveLength(1);
  });
});

describe('what the table itself guarantees (issue #80)', () => {
  it('refuses a link on a request that is not approved, and an approval without one', async () => {
    const user = await insertUser('constraints');
    const base = { user_id: user.id, old_email: user.email, new_email: unique('constraint-new') };

    for (const status of ['pending', 'rejected', 'completed', 'superseded']) {
      await expect(getOwner().knex('email_change_requests').insert({
        ...base, status, token_hash: `hash-${randomUUID()}`, token_expires_at: new Date(Date.now() + 60_000)
      }), status).rejects.toThrow(/email_change_requests_token_only_when_approved/);
    }
    await expect(getOwner().knex('email_change_requests').insert({ ...base, status: 'approved' }))
      .rejects.toThrow(/email_change_requests_token_only_when_approved/);
    await expect(getOwner().knex('email_change_requests').insert({ ...base, status: 'approved', token_hash: 'only-a-hash' }))
      .rejects.toThrow(/email_change_requests_token_pair/);
    await expect(getOwner().knex('email_change_requests').insert({ ...base, new_email: 'Not.Normalized@Email-Change.test' }))
      .rejects.toThrow(/email_change_requests_new_email_normalized/);
    expect(await requestsOf(user.id)).toEqual([]);
  });

  it('allows one open request per account and one holder per link', async () => {
    const user = await insertUser('one-open');
    const other = await insertUser('one-open-other');
    const base = (account: { id: string; email: string }) => ({ user_id: account.id, old_email: account.email, new_email: unique('open-new') });
    await getOwner().knex('email_change_requests').insert(base(user));

    await expect(getOwner().knex('email_change_requests').insert({ ...base(user), status: 'approved', token_hash: 'a', token_expires_at: new Date(Date.now() + 60_000) }))
      .rejects.toThrow(/email_change_requests_one_open_per_user/);
    await getOwner().knex('email_change_requests').insert({ ...base(other), status: 'approved', token_hash: 'shared-hash', token_expires_at: new Date(Date.now() + 60_000) });
    const third = await insertUser('one-open-third');
    await expect(getOwner().knex('email_change_requests').insert({ ...base(third), status: 'approved', token_hash: 'shared-hash', token_expires_at: new Date(Date.now() + 60_000) }))
      .rejects.toThrow(/email_change_requests_token_hash_key/);
  });
});

describe('the email change functions are not open to everyone (issue #80)', () => {
  it('are executable by ageniza_app and not by PUBLIC', async () => {
    const result = await raw<{ rows: { name: string; app: boolean; public_role: boolean }[] }>(getOwner().knex, `
      select p.proname as name,
        has_function_privilege('ageniza_app', p.oid, 'execute') as app,
        exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl where acl.grantee = 0
        ) as public_role
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private'
        and p.proname in ('request_email_change', 'confirm_email_change', 'supersede_email_change_requests', 'credential_fingerprint')
      order by p.proname
    `, []);
    // The fingerprint reads the credential table and is for the functions above and the CLI only.
    expect(result.rows).toEqual([
      { name: 'confirm_email_change', app: true, public_role: false },
      { name: 'credential_fingerprint', app: false, public_role: false },
      { name: 'request_email_change', app: true, public_role: false },
      { name: 'supersede_email_change_requests', app: true, public_role: false }
    ]);
  });
});
