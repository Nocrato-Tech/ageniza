import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #212. The derived thread state (thread-state.ts) is "open while resolved_at is null or
// earlier than the latest comment". `created_at` and `resolved_at` both default to now(), the
// transaction start, so a client comment whose transaction began before a resolve and committed
// after it used to land with created_at earlier than resolved_at and leave the thread resolved.
// This suite proves the explicit reopen: a DEFERRABLE INITIALLY DEFERRED trigger clears the
// resolution on a client comment at COMMIT, and locks the thread row so it serializes with a
// concurrent resolve. Runs as ageniza_app, with two real connections where the race matters.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const ownerA = randomUUID();
const adminA = randomUUID();
const portalUser = randomUUID();
const clientA = randomUUID();

type Rows<T> = { readonly rows: readonly T[] };

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

const setUser = (transaction: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0], userId: string): Promise<unknown> =>
  raw(transaction, 'select app_private.bind_actor(?::uuid)', [userId]);

const createThread = async (resolved: boolean): Promise<string> => {
  const id = randomUUID();
  await getOwner().knex('client_threads').insert({
    id,
    client_id: clientA,
    section_key: 'branding',
    opened_by: adminA,
    opened_side: 'agency',
    resolved_at: resolved ? new Date() : null,
    resolved_by: resolved ? adminA : null
  });
  return id;
};

const insertComment = (userId: string, threadId: string, side: 'agency' | 'client', body: string): Promise<unknown> =>
  asUser(userId, (transaction) => raw(transaction, `
    insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
    values (?::uuid, ?::uuid, ?::uuid, ?, ?)
  `, [threadId, clientA, userId, side, body]));

const threadResolvedAt = async (threadId: string): Promise<Date | null> => {
  const row = await getOwner().knex('client_threads').where({ id: threadId }).first<{ resolved_at: Date | null }>('resolved_at');
  return row?.resolved_at ?? null;
};

const lastCommentSide = async (threadId: string): Promise<string | null> => {
  const row = await getOwner().knex('client_thread_comments')
    .where({ thread_id: threadId })
    .orderBy('created_at', 'desc')
    .first<{ author_side: string }>('author_side');
  return row?.author_side ?? null;
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const roles = await getOwner().knex('roles').whereNull('agency_id').where('key', 'admin').first<{ id: string }>('id');
  if (roles === undefined) throw new Error('Admin role seed is missing.');

  await getOwner().transaction(async (transaction) => {
    await transaction('auth.user').insert([
      { id: ownerA, name: 'Owner A', email: `owner-${ownerA}@example.test`, emailVerified: true },
      { id: adminA, name: 'Admin A', email: `admin-${adminA}@example.test`, emailVerified: true },
      { id: portalUser, name: 'Portal', email: `portal-${portalUser}@example.test`, emailVerified: true }
    ]);
    await transaction('agencies').insert({ id: agencyA, name: `Agency A ${agencyA}`, owner_user_id: ownerA });
    await transaction('agency_memberships').insert({ agency_id: agencyA, user_id: adminA, role_id: roles.id });
    await transaction('clients').insert({ id: clientA, agency_id: agencyA, name: `Client A ${clientA}` });
    await transaction('client_memberships').insert({ client_id: clientA, user_id: portalUser });
  });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('client_thread_comments').whereIn('client_id', [clientA]).delete();
      await transaction('client_threads').whereIn('client_id', [clientA]).delete();
      await transaction('client_memberships').whereIn('client_id', [clientA]).delete();
      await transaction('agency_memberships').whereIn('agency_id', [agencyA]).delete();
      await transaction('clients').whereIn('id', [clientA]).delete();
      await transaction('agencies').whereIn('id', [agencyA]).update({ owner_user_id: null });
      await transaction('agencies').whereIn('id', [agencyA]).delete();
      await transaction('auth.user').whereIn('id', [ownerA, adminA, portalUser]).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('client thread reopen on a client comment (#212)', () => {
  it('installs the reopen trigger as deferrable and initially deferred', async () => {
    const rows = await getOwner().knex.raw<Rows<{ tgdeferrable: boolean; tginitdeferred: boolean }>>(`
      select tgdeferrable, tginitdeferred
      from pg_catalog.pg_trigger
      where tgname = 'client_thread_comments_reopen'
    `);
    expect(rows.rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  });

  it('reopens the thread when a client comment commits after a concurrent resolve', async () => {
    const thread = await createThread(false);

    let inserted!: () => void;
    const hasInserted = new Promise<void>((resolve) => { inserted = resolve; });
    let releaseA!: () => void;
    const aMayFinish = new Promise<void>((resolve) => { releaseA = resolve; });

    // Session A (portal) inserts the comment and holds its transaction open.
    const sessionA = getApplication().transaction(async (transaction) => {
      await setUser(transaction, portalUser);
      await raw(transaction, `
        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        values (?::uuid, ?::uuid, ?::uuid, 'client', 'pergunta durante a resolução')
      `, [thread, clientA, portalUser]);
      inserted();
      await aMayFinish;
    });
    await hasInserted;

    // Session B (agency) resolves and commits while A is still open.
    await getApplication().transaction(async (transaction) => {
      await setUser(transaction, ownerA);
      await raw(transaction, `
        update public.client_threads set resolved_at = now(), resolved_by = ?::uuid where id = ?::uuid
      `, [ownerA, thread]);
    });

    releaseA();
    await sessionA;

    // A committed last; the deferred reopen cleared the resolution.
    expect(await threadResolvedAt(thread)).toBeNull();
    expect(await lastCommentSide(thread)).toBe('client');
  });

  it('does not reopen on an agency comment', async () => {
    const thread = await createThread(true);
    await insertComment(adminA, thread, 'agency', 'resposta da agência');
    expect(await threadResolvedAt(thread)).not.toBeNull();
  });

  it('reopens on a client comment after the resolution', async () => {
    const thread = await createThread(true);
    await insertComment(portalUser, thread, 'client', 'nova dúvida');
    expect(await threadResolvedAt(thread)).toBeNull();
  });

  it('locks the thread so a comment committing during a resolve is not lost', async () => {
    const thread = await createThread(false);

    let locked!: () => void;
    const hasLocked = new Promise<void>((resolve) => { locked = resolve; });
    let releaseB!: () => void;
    const bMayFinish = new Promise<void>((resolve) => { releaseB = resolve; });

    // Session B (agency) resolves and holds the thread row lock, uncommitted.
    const sessionB = getApplication().transaction(async (transaction) => {
      await setUser(transaction, ownerA);
      await raw(transaction, `
        update public.client_threads set resolved_at = now(), resolved_by = ?::uuid where id = ?::uuid
      `, [ownerA, thread]);
      locked();
      await bMayFinish;
    });
    await hasLocked;

    // Session A (portal) inserts and commits; its deferred trigger must wait for B's lock, then
    // read the committed resolution and clear it.
    const sessionA = getApplication().transaction(async (transaction) => {
      await setUser(transaction, portalUser);
      await raw(transaction, `
        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        values (?::uuid, ?::uuid, ?::uuid, 'client', 'comentário sob a trava')
      `, [thread, clientA, portalUser]);
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseB();
    await Promise.all([sessionA, sessionB]);

    expect(await threadResolvedAt(thread)).toBeNull();
  });
});
