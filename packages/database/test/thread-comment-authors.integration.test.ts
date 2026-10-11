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

// Issues #128 and #130. `app_private.thread_comment_authors` is the one read path the agency and
// the portal share for "who wrote this comment": the name and photo of the author's link, resolved
// through a `security definer` function because the portal cannot read `agency_memberships` or
// another person's `client_memberships` under RLS. Everything runs as ageniza_app, with people who
// belong to more than one tenant so that a missing filter shows up as a leaked row.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const adminA = randomUUID();
const adminB = randomUUID();
const portalOne = randomUUID();
const portalTwo = randomUUID();
const portalOtherClient = randomUUID();
const bothSides = randomUUID();
const outsider = randomUUID();
const clientA = randomUUID();
const clientOther = randomUUID();
const clientB = randomUUID();
const activePersona = randomUUID();
const archivedPersona = randomUUID();
const threadSection = randomUUID();
const threadActivePersona = randomUUID();
const threadArchivedPersona = randomUUID();
const threadOtherClient = randomUUID();
const threadMixedSides = randomUUID();
const resolverOnly = randomUUID();
const threadResolved = randomUUID();

const allUsers = [ownerA, ownerB, adminA, adminB, portalOne, portalTwo, portalOtherClient, bothSides, outsider, resolverOnly];

type Rows<T> = { readonly rows: readonly T[] };
type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface AuthorRow {
  readonly author_user_id: string;
  readonly author_side: string;
  readonly name: string;
  readonly photo_key: string | null;
}

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(userId: string, work: (transaction: Transaction) => Promise<TResult>): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const authorsAs = (userId: string, threadId: string): Promise<readonly AuthorRow[]> =>
  asUser(userId, async (transaction) => {
    const result = await raw<Rows<AuthorRow>>(transaction, `
      select * from app_private.thread_comment_authors(?::uuid) order by author_side, name
    `, [threadId]);
    return result.rows;
  });

/** What the `client_threads_select` policy itself lets this caller read, for the same thread. */
const policyReadableAs = (userId: string, threadId: string): Promise<boolean> =>
  asUser(userId, async (transaction) => {
    const result = await raw<Rows<{ id: string }>>(transaction, 'select id from public.client_threads where id = ?::uuid', [threadId]);
    return result.rows.length === 1;
  });

const adminAuthor = { author_user_id: adminA, author_side: 'agency', name: 'Admin A', photo_key: 'users/admin-a.png' };
const portalOneAuthor = { author_user_id: portalOne, author_side: 'client', name: 'Portal One', photo_key: null };
const portalTwoAuthor = { author_user_id: portalTwo, author_side: 'client', name: 'Portal Two', photo_key: null };

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const role = await getOwner().knex('roles').whereNull('agency_id').where('key', 'admin').first<{ id: string }>('id');
  if (role === undefined) throw new Error('Admin role seed is missing.');

  await getOwner().transaction(async (transaction) => {
    const user = (id: string, name: string, image: string | null = null) => ({
      id, name, image, email: `${name.toLowerCase().replace(/\s+/g, '-')}-${id}@example.test`, emailVerified: true
    });
    await transaction('auth.user').insert([
      user(ownerA, 'Owner A'),
      user(ownerB, 'Owner B'),
      user(adminA, 'Admin A', 'users/admin-a.png'),
      user(adminB, 'Admin B'),
      user(portalOne, 'Portal One'),
      user(portalTwo, 'Portal Two'),
      user(portalOtherClient, 'Portal Other'),
      user(bothSides, 'Both Sides'),
      user(resolverOnly, 'Resolver Only', 'users/resolver.png'),
      user(outsider, 'Outsider')
    ]);
    await transaction('agencies').insert([
      { id: agencyA, name: `Agency A ${agencyA}`, owner_user_id: ownerA },
      { id: agencyB, name: `Agency B ${agencyB}`, owner_user_id: ownerB }
    ]);
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: adminA, role_id: role.id },
      { agency_id: agencyA, user_id: bothSides, role_id: role.id },
      { agency_id: agencyA, user_id: resolverOnly, role_id: role.id },
      { agency_id: agencyB, user_id: adminB, role_id: role.id }
    ]);
    await transaction('clients').insert([
      { id: clientA, agency_id: agencyA, name: `Client A ${clientA}` },
      { id: clientOther, agency_id: agencyA, name: `Client Other ${clientOther}` },
      { id: clientB, agency_id: agencyB, name: `Client B ${clientB}` }
    ]);
    await transaction('client_memberships').insert([
      { client_id: clientA, user_id: portalOne },
      { client_id: clientA, user_id: portalTwo },
      { client_id: clientA, user_id: bothSides },
      { client_id: clientOther, user_id: portalOtherClient }
    ]);
    await transaction('client_personas').insert([
      { id: activePersona, client_id: clientA, name: 'Active persona', updated_by: adminA },
      { id: archivedPersona, client_id: clientA, name: 'Archived persona', updated_by: adminA }
    ]);
    await transaction('client_personas').where({ id: archivedPersona }).update({ status: 'archived' });
    await transaction('client_threads').insert([
      { id: threadSection, client_id: clientA, section_key: 'branding', opened_by: adminA, opened_side: 'agency' },
      { id: threadActivePersona, client_id: clientA, persona_id: activePersona, opened_by: portalOne, opened_side: 'client' },
      { id: threadArchivedPersona, client_id: clientA, persona_id: archivedPersona, opened_by: adminA, opened_side: 'agency' },
      { id: threadOtherClient, client_id: clientOther, section_key: 'branding', opened_by: adminA, opened_side: 'agency' },
      { id: threadMixedSides, client_id: clientA, section_key: 'colors', opened_by: adminA, opened_side: 'agency' },
      { id: threadResolved, client_id: clientA, section_key: 'observations', opened_by: portalOne, opened_side: 'client' }
    ]);
    const comment = (thread: string, client: string, author: string, side: 'agency' | 'client') =>
      ({ thread_id: thread, client_id: client, author_user_id: author, author_side: side, body: `by ${side}` });
    await transaction('client_thread_comments').insert([
      comment(threadSection, clientA, adminA, 'agency'),
      comment(threadSection, clientA, adminA, 'agency'),
      comment(threadSection, clientA, portalOne, 'client'),
      comment(threadSection, clientA, portalTwo, 'client'),
      comment(threadActivePersona, clientA, portalOne, 'client'),
      comment(threadArchivedPersona, clientA, adminA, 'agency'),
      comment(threadOtherClient, clientOther, adminA, 'agency'),
      comment(threadOtherClient, clientOther, portalOtherClient, 'client'),
      // The same person writes from the two sides: each comment must resolve through its own link.
      comment(threadMixedSides, clientA, bothSides, 'agency'),
      comment(threadMixedSides, clientA, bothSides, 'client'),
      comment(threadResolved, clientA, portalOne, 'client')
    ]);
  });

  // Resolved by someone who never commented on it: the resolver is not a comment author. It is
  // resolved after the fixture committed, because a client comment reopens its thread at commit.
  await getOwner().knex('client_threads').where({ id: threadResolved }).update({ resolved_by: resolverOnly, resolved_at: new Date() });
});

afterAll(async () => {
  try {
    await getOwner().transaction(async (transaction) => {
      await transaction('client_thread_comments').whereIn('client_id', [clientA, clientOther, clientB]).delete();
      await transaction('client_threads').whereIn('client_id', [clientA, clientOther, clientB]).delete();
      await transaction('client_personas').whereIn('client_id', [clientA, clientOther, clientB]).delete();
      await transaction('client_memberships').whereIn('client_id', [clientA, clientOther, clientB]).delete();
      await transaction('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
      await transaction('clients').whereIn('id', [clientA, clientOther, clientB]).delete();
      await transaction('agencies').whereIn('id', [agencyA, agencyB]).update({ owner_user_id: null });
      await transaction('agencies').whereIn('id', [agencyA, agencyB]).delete();
      await transaction('auth.user').whereIn('id', allUsers).delete();
    });
  } finally {
    await getApplication().close();
    await getOwner().close();
  }
});

describe('thread_comment_authors (#128, #130)', () => {
  it('gives the agency collaborator each author of the thread once, with the link name and photo key', async () => {
    expect(await authorsAs(adminA, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
  });

  it('gives the portal person of that client exactly what the agency gets', async () => {
    expect(await authorsAs(portalOne, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
  });

  it('returns only the four documented columns', async () => {
    const [row] = await authorsAs(adminA, threadSection);
    expect(Object.keys(row ?? {}).sort()).toEqual(['author_side', 'author_user_id', 'name', 'photo_key']);
  });

  it('gives zero rows to a person of another client of the same agency, who still reads their own client', async () => {
    expect(await authorsAs(portalOtherClient, threadSection)).toEqual([]);
    expect(await authorsAs(portalOtherClient, threadOtherClient)).toHaveLength(2);
  });

  it('gives zero rows to a collaborator of another agency', async () => {
    expect(await authorsAs(adminB, threadSection)).toEqual([]);
    expect(await authorsAs(ownerB, threadSection)).toEqual([]);
  });

  it('gives zero rows to a person with no link at all', async () => {
    expect(await authorsAs(outsider, threadSection)).toEqual([]);
  });

  it('gives zero rows, not an error, for a thread that does not exist', async () => {
    expect(await authorsAs(adminA, randomUUID())).toEqual([]);
  });

  it('does not tell an unreadable thread apart from a missing one', async () => {
    const unreadable = await authorsAs(outsider, threadSection);
    const missing = await authorsAs(outsider, randomUUID());
    expect(unreadable).toEqual(missing);
  });

  it('gives zero rows to a person whose client link was removed, and keeps answering for the others', async () => {
    await getOwner().knex('client_memberships').where({ client_id: clientA, user_id: portalTwo }).update({ status: 'removed' });
    try {
      expect(await authorsAs(portalTwo, threadSection)).toEqual([]);
      expect(await authorsAs(portalOne, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
    } finally {
      await getOwner().knex('client_memberships').where({ client_id: clientA, user_id: portalTwo }).update({ status: 'active' });
    }
  });

  it('keeps the name of a removed collaborator, because the comment is history', async () => {
    await getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: adminA }).update({ status: 'removed' });
    try {
      expect(await authorsAs(adminA, threadSection)).toEqual([]);
      expect(await authorsAs(portalOne, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
    } finally {
      await getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: adminA }).update({ status: 'active' });
    }
  });

  it('keeps the name of a removed portal person, because the comment is history', async () => {
    await getOwner().knex('client_memberships').where({ client_id: clientA, user_id: portalTwo }).update({ status: 'removed' });
    try {
      expect(await authorsAs(adminA, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
    } finally {
      await getOwner().knex('client_memberships').where({ client_id: clientA, user_id: portalTwo }).update({ status: 'active' });
    }
  });

  it('hides a thread of an archived persona from the portal and keeps it for the agency', async () => {
    expect(await authorsAs(portalOne, threadArchivedPersona)).toEqual([]);
    expect(await authorsAs(adminA, threadArchivedPersona)).toEqual([adminAuthor]);
    expect(await authorsAs(portalOne, threadActivePersona)).toEqual([portalOneAuthor]);
  });

  it('gives zero rows to a portal person once the client is archived', async () => {
    await getOwner().knex('clients').where({ id: clientA }).update({ status: 'archived' });
    try {
      expect(await authorsAs(portalOne, threadSection)).toEqual([]);
      expect(await authorsAs(adminA, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
    } finally {
      await getOwner().knex('clients').where({ id: clientA }).update({ status: 'active' });
    }
  });

  it('resolves each comment through the link of its own side', async () => {
    const rows = await authorsAs(adminA, threadMixedSides);
    expect(rows.map((row) => ({ id: row.author_user_id, side: row.author_side, name: row.name }))).toEqual([
      { id: bothSides, side: 'agency', name: 'Both Sides' },
      { id: bothSides, side: 'client', name: 'Both Sides' }
    ]);
  });

  it('also returns who resolved the thread, on the agency side, even when they never commented', async () => {
    const resolver = { author_user_id: resolverOnly, author_side: 'agency', name: 'Resolver Only', photo_key: 'users/resolver.png' };
    expect(await authorsAs(adminA, threadResolved)).toEqual([resolver, portalOneAuthor]);
    expect(await authorsAs(portalOne, threadResolved)).toEqual([resolver, portalOneAuthor]);
    expect(await authorsAs(portalTwo, threadResolved)).toEqual([resolver, portalOneAuthor]);
    // A thread nobody resolved has no resolver row.
    expect(await authorsAs(adminA, threadSection)).toEqual([adminAuthor, portalOneAuthor, portalTwoAuthor]);
  });

  it('keeps the name of a resolver whose link was removed, and gives the resolver nothing once removed', async () => {
    await getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: resolverOnly }).update({ status: 'removed' });
    try {
      expect(await authorsAs(portalOne, threadResolved)).toEqual([
        { author_user_id: resolverOnly, author_side: 'agency', name: 'Resolver Only', photo_key: 'users/resolver.png' },
        portalOneAuthor
      ]);
      expect(await authorsAs(resolverOnly, threadResolved)).toEqual([]);
    } finally {
      await getOwner().knex('agency_memberships').where({ agency_id: agencyA, user_id: resolverOnly }).update({ status: 'active' });
    }
  });

  it('hides the resolver from whoever cannot read the thread', async () => {
    expect(await authorsAs(portalOtherClient, threadResolved)).toEqual([]);
    expect(await authorsAs(adminB, threadResolved)).toEqual([]);
    expect(await authorsAs(outsider, threadResolved)).toEqual([]);
  });

  it('resolves the resolver only through an agency link, never through a client link', async () => {
    const stray = randomUUID();
    await getOwner().knex('client_threads').insert({
      id: stray, client_id: clientA, section_key: 'tone_of_voice', opened_by: adminA, opened_side: 'agency', resolved_by: portalTwo, resolved_at: new Date()
    });
    await getOwner().knex('client_thread_comments').insert({
      thread_id: stray, client_id: clientA, author_user_id: adminA, author_side: 'agency', body: 'x'
    });
    try {
      expect(await authorsAs(adminA, stray)).toEqual([adminAuthor]);
    } finally {
      await getOwner().knex('client_thread_comments').where({ thread_id: stray }).delete();
      await getOwner().knex('client_threads').where({ id: stray }).delete();
    }
  });

  it('does not borrow the other side\'s link for a comment whose side the author never held', async () => {
    const stray = randomUUID();
    await getOwner().knex('client_threads').insert({
      id: stray, client_id: clientA, section_key: 'positioning', opened_by: adminA, opened_side: 'agency'
    });
    // Inserted by the schema owner on purpose: RLS would never let ageniza_app write these rows,
    // and the point is what the read function does if the data ever disagrees with the links.
    await getOwner().knex('client_thread_comments').insert([
      { thread_id: stray, client_id: clientA, author_user_id: portalOne, author_side: 'agency', body: 'portal person as agency' },
      { thread_id: stray, client_id: clientA, author_user_id: adminA, author_side: 'client', body: 'collaborator as client' }
    ]);
    try {
      expect(await authorsAs(adminA, stray)).toEqual([]);
    } finally {
      await getOwner().knex('client_thread_comments').where({ thread_id: stray }).delete();
      await getOwner().knex('client_threads').where({ id: stray }).delete();
    }
  });

  it('does not resolve a link that belongs to another agency or another client', async () => {
    const stray = randomUUID();
    await getOwner().knex('client_threads').insert({
      id: stray, client_id: clientA, section_key: 'archetype', opened_by: adminA, opened_side: 'agency'
    });
    await getOwner().knex('client_thread_comments').insert([
      { thread_id: stray, client_id: clientA, author_user_id: adminB, author_side: 'agency', body: 'collaborator of another agency' },
      { thread_id: stray, client_id: clientA, author_user_id: portalOtherClient, author_side: 'client', body: 'person of another client' }
    ]);
    try {
      expect(await authorsAs(adminA, stray)).toEqual([]);
    } finally {
      await getOwner().knex('client_thread_comments').where({ thread_id: stray }).delete();
      await getOwner().knex('client_threads').where({ id: stray }).delete();
    }
  });

  it('reads a thread for exactly the callers the client_threads policy lets read it', async () => {
    const callers = [adminA, ownerA, bothSides, portalOne, portalTwo, portalOtherClient, adminB, ownerB, outsider, resolverOnly];
    const threads = [threadSection, threadActivePersona, threadArchivedPersona, threadOtherClient, threadMixedSides, threadResolved];
    for (const caller of callers) {
      for (const thread of threads) {
        const byPolicy = await policyReadableAs(caller, thread);
        const byFunction = (await authorsAs(caller, thread)).length > 0;
        expect({ caller, thread, byFunction }).toEqual({ caller, thread, byFunction: byPolicy });
      }
    }
  });

  it('is executable by ageniza_app and by nobody else through PUBLIC', async () => {
    const { rows } = await raw<Rows<{ app: boolean; public_execute: boolean }>>(getOwner().knex, `
      select
        has_function_privilege('ageniza_app', 'app_private.thread_comment_authors(uuid)', 'execute') as app,
        has_function_privilege('public', 'app_private.thread_comment_authors(uuid)', 'execute') as public_execute
    `, []);
    expect(rows).toEqual([{ app: true, public_execute: false }]);
  });
});
