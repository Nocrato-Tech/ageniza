import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createContentWorld, type ContentStatus } from './support/content-world.js';

// Issue #712 (decision 2026-10-26, "o e-mail de aprovação leva um link que aprova sem login"): each e-mail "conteúdos para aprovar"
// carries a link of the access, tied to the contents of the batch. The link is exchanged for a session, reads the batch, and decides
// as that access. Every call runs as `ageniza_app` with NO actor bound, which is how a request without a login reaches the database.
// RLS filters silently, so a read is checked by the rows it returns and a write by the state left in the tables.
const w = createContentWorld('portal-approval-links');
const { ids } = w;
const { applicationUrl } = resolveIntegrationDatabaseUrls();

let worker: DatabaseClient;
const extraUsers: string[] = [];
const extraClients: string[] = [];

const owner = (): Knex => w.getOwner().knex;
const asApp = <T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => worker.knex.transaction(work);

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
});

afterAll(async () => {
  try {
    const knex = owner();
    await knex('client_portal_approval_links').whereIn('client_id', extraClients).delete();
    await knex('notification_queue').whereIn('client_id', extraClients).delete();
    await knex('client_thread_comments').whereIn('client_id', extraClients).delete();
    await knex('client_threads').whereIn('client_id', extraClients).delete();
    await knex('content_media').whereIn('client_id', extraClients).delete();
    await knex('contents').whereIn('client_id', extraClients).delete();
    await knex('media_assets').whereIn('client_id', extraClients).delete();
    await knex('media_folders').whereIn('client_id', extraClients).delete();
    await knex('client_memberships').whereIn('client_id', extraClients).delete();
    await knex('clients').whereIn('id', extraClients).delete();
    await knex('client_memberships').whereIn('user_id', extraUsers).delete();
    await knex('auth.user').whereIn('id', extraUsers).delete();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const freshEmail = (): string => `${randomUUID()}@approval-address.test`;
const newToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha(token) };
};

const freshClient = async (): Promise<string> => {
  const id = randomUUID();
  extraClients.push(id);
  await owner()('clients').insert({ id, agency_id: ids.agencyA, name: `Aprovação ${id}` });
  return id;
};

const newAccess = async (clientId: string, email = freshEmail()): Promise<{ id: string; email: string }> => {
  const [row] = await owner()('client_portal_accesses').insert({ client_id: clientId, email }).returning(['id', 'email']);
  return row as { id: string; email: string };
};

const awaitingContent = (clientId: string, extra: Parameters<typeof w.seedContent>[1] = {}): Promise<string> =>
  w.seedContent(clientId, { status: 'awaiting_approval', ...extra });

/** Items of the queue, claimed by the worker, for a content each: what the function that issues a link takes to prove the e-mail. */
const claim = async (accessId: string, clientId: string, contentIds: readonly string[], type = 'content_awaiting_approval'): Promise<{ itemIds: string[]; claimToken: string }> => {
  const claimToken = randomUUID();
  const itemIds: string[] = [];
  for (const contentId of contentIds) {
    const result = await owner().raw<{ rows: Array<{ id: string }> }>(`
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
      values (?, ?, ?, ?, now() - interval '1 minute', now(), ?, 1)
      on conflict (type, content_id, recipient_portal_access_id) where sent_at is null and discarded_at is null
      do update set claimed_at = now(), claim_token = excluded.claim_token
      returning id
    `, [type, clientId, accessId, contentId, claimToken]);
    itemIds.push(result.rows[0]!.id);
  }
  return { itemIds, claimToken };
};

const issue = (itemIds: readonly string[], claimToken: string, tokenHash: string): Promise<Date> =>
  asApp(async (transaction) =>
    (await transaction.raw<{ rows: Array<{ expires_at: Date }> }>(
      'select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?) as expires_at', [[...itemIds], claimToken, tokenHash]
    )).rows[0]!.expires_at
  );

const exchange = (tokenHash: string, sessionHash: string): Promise<{ session_expires_at: Date; link_expires_at: Date }> =>
  asApp(async (transaction) =>
    (await transaction.raw<{ rows: Array<{ session_expires_at: Date; link_expires_at: Date }> }>(
      'select * from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, sessionHash]
    )).rows[0]!
  );

interface Scenario {
  readonly clientId: string;
  readonly accessId: string;
  readonly email: string;
  readonly contents: string[];
  readonly token: string;
  readonly tokenHash: string;
  readonly linkId: string;
  readonly sessionHash: string;
}

interface ScenarioOptions {
  readonly contents?: number;
  readonly clientId?: string;
  readonly email?: string;
  readonly exchanged?: boolean;
}

/** An access, `contents` contents awaiting approval, the link of their e-mail and, by default, the session of its cookie. */
const scenario = async (options: ScenarioOptions = {}): Promise<Scenario> => {
  const clientId = options.clientId ?? await freshClient();
  const access = await newAccess(clientId, options.email);
  const contents: string[] = [];
  for (let index = 0; index < (options.contents ?? 2); index += 1) {
    contents.push(await awaitingContent(clientId, { publishOn: `2026-10-${String(20 + index).padStart(2, '0')}` }));
  }
  const { itemIds, claimToken } = await claim(access.id, clientId, contents);
  const { token, hash } = newToken();
  await issue(itemIds, claimToken, hash);
  const link = await owner()('client_portal_approval_links').where({ token_hash: hash }).first('id');
  const session = newToken();
  if (options.exchanged !== false) await exchange(hash, session.hash);
  return { clientId, accessId: access.id, email: access.email, contents, token, tokenHash: hash, linkId: link!.id as string, sessionHash: session.hash };
};

const batchOf = (sessionHash: string): Promise<Array<Record<string, unknown>>> =>
  asApp(async (transaction) => (await transaction.raw<{ rows: Array<Record<string, unknown>> }>('select * from app_private.portal_approval_batch(?)', [sessionHash])).rows);
// A row as the database returns it: the tests read columns by name, and the shape of each table is asserted where it matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper over untyped rows
type Row = Record<string, any>;
/** The row without the columns that are different by construction between two things being compared. */
const without = (row: Row, ...columns: readonly string[]): Row => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));
const contentsOf = (sessionHash: string): Promise<Row[]> =>
  asApp(async (transaction) => (await transaction.raw<{ rows: Row[] }>('select * from app_private.portal_approval_contents(?)', [sessionHash])).rows);
const mediaOf = (sessionHash: string): Promise<Row[]> =>
  asApp(async (transaction) => (await transaction.raw<{ rows: Row[] }>('select * from app_private.portal_approval_media(?)', [sessionHash])).rows);
const approveBy = (sessionHash: string, contentId: string, revision = 1): Promise<unknown> =>
  asApp((transaction) => transaction.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, ?::integer)', [sessionHash, contentId, revision]));
const requestBy = (sessionHash: string, contentId: string, comment: string, revision = 1): Promise<unknown> =>
  asApp((transaction) => transaction.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, ?::integer, ?)', [sessionHash, contentId, revision, comment]));

const contentOf = (id: string): Promise<Row> => w.contentRow(id) as Promise<Row>;
const threadsOf = (contentId: string): Promise<Row[]> => owner()('client_threads').where({ content_id: contentId }) as Promise<Row[]>;
const commentsOfThread = (threadId: string): Promise<Row[]> => owner()('client_thread_comments').where({ thread_id: threadId }) as Promise<Row[]>;

const joinPortal = async (clientId: string): Promise<string> => {
  const id = randomUUID();
  extraUsers.push(id);
  await owner()('auth.user').insert({ id, name: `Portal ${id.slice(0, 8)}`, email: `${id}@approval-portal.test`, emailVerified: true });
  await owner()('client_memberships').insert({ client_id: clientId, user_id: id });
  return id;
};

const asAccount = <T>(user: string, work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => w.asUser(user, work);

const setAgencyReadOnly = (): Promise<unknown> => owner()('agencies').where({ id: ids.agencyA }).update({
  plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
});
const setAgencyOpen = (): Promise<unknown> => owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null, status: 'active' });

// ---- the tables are closed to the application role ---------------------------------------------------------------------

describe('the tables of the approval link are closed to the application role (#712)', () => {
  const TABLES = ['client_portal_approval_links', 'client_portal_approval_link_contents', 'client_portal_approval_sessions'] as const;

  it.each(TABLES)('gives ageniza_app no privilege on %s, on the table or on any column', async (table) => {
    expect(await w.tablePrivileges(table)).toEqual({ can_select: false, table_insert: false, table_update: false, can_delete: false, can_truncate: false });
    expect(await w.columnsWithPrivilege(table, 'insert')).toEqual([]);
    expect(await w.columnsWithPrivilege(table, 'update')).toEqual([]);
  });

  it.each(TABLES)('keeps row level security on and forced on %s, with no policy', async (table) => {
    const flags = await owner().raw<{ rows: Array<{ enabled: boolean; forced: boolean }> }>(
      'select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where oid = ?::regclass', [`public.${table}`]
    );
    expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
    const policies = await owner().raw<{ rows: unknown[] }>("select 1 from pg_policies where schemaname = 'public' and tablename = ?", [table]);
    expect(policies.rows).toEqual([]);
  });

  it('refuses a read and a write of the links as ageniza_app, the account bound or not', async () => {
    const s = await scenario();
    for (const run of [
      () => asApp((t) => t('client_portal_approval_links').select('id')),
      () => asApp((t) => t('client_portal_approval_sessions').select('id')),
      () => asApp((t) => t('client_portal_approval_link_contents').select('content_id')),
      () => asApp((t) => t('client_portal_approval_links').where({ id: s.linkId }).update({ generation: 9 })),
      () => asApp((t) => t('client_portal_approval_sessions').insert({ link_id: s.linkId, session_hash: sha('x'), expires_at: t.raw("now() + interval '1 hour'") })),
      () => asAccount(ids.adminA, (t) => t('client_portal_approval_links').select('id'))
    ]) {
      await expect(run()).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    }
    expect(await owner()('client_portal_approval_links').where({ id: s.linkId }).first('generation')).toEqual({ generation: 1 });
  });

  it('closes the context of the decision: the application role neither reads nor writes it', async () => {
    const s = await scenario();
    await expect(asApp((t) => t.raw('select * from app_private.portal_approval_context'))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp((t) => t.raw(
      'insert into app_private.portal_approval_context (xact_id, access_id, link_id) values (pg_current_xact_id(), ?::uuid, ?::uuid)', [s.accessId, s.linkId]
    ))).rejects.toMatchObject({ code: '42501' });
    expect((await asApp((t) => t.raw<{ rows: Array<{ id: string | null }> }>('select app_private.portal_approval_access_id() as id'))).rows[0]!.id).toBeNull();
  });
});

// ---- issuing the link --------------------------------------------------------------------------------------------------

describe('issuing the link (the worker, from the items of the e-mail)', () => {
  it('stores the hash of the token and never the token, with the generation of the access and seven days', async () => {
    const clientId = await freshClient();
    const access = await newAccess(clientId);
    await owner()('client_portal_accesses').where({ id: access.id }).update({ status: 'removed', generation: 2 });
    await owner()('client_portal_accesses').where({ id: access.id }).update({ status: 'active' });
    const content = await awaitingContent(clientId);
    const { itemIds, claimToken } = await claim(access.id, clientId, [content]);
    const { token, hash } = newToken();
    const before = Date.now();
    const expiresAt = await issue(itemIds, claimToken, hash);

    const link = await owner()('client_portal_approval_links').where({ token_hash: hash }).first();
    expect(link).toMatchObject({ portal_access_id: access.id, client_id: clientId, generation: 2, token_hash: hash });
    expect(JSON.stringify(link)).not.toContain(token);
    const days = (expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(new Date(link.expires_at).getTime()).toBe(expiresAt.getTime());
    expect((await owner()('client_portal_approval_link_contents').where({ link_id: link.id })).map((row) => row.content_id)).toEqual([content]);
  });

  it('ties the link to the contents of the e-mail and to no other content of the client', async () => {
    const s = await scenario({ contents: 2 });
    const outside = await awaitingContent(s.clientId);
    const lot = (await owner()('client_portal_approval_link_contents').where({ link_id: s.linkId })).map((row) => row.content_id as string);
    expect([...lot].sort()).toEqual([...s.contents].sort());
    expect(lot).not.toContain(outside);
  });

  it('refuses a link over seven days, whoever writes the row (the check of the table)', async () => {
    const s = await scenario();
    await expect(owner()('client_portal_approval_links').insert({
      portal_access_id: s.accessId, client_id: s.clientId, generation: 1, token_hash: sha(randomUUID()),
      created_at: owner().raw('now()'), expires_at: owner().raw("now() + interval '8 days'")
    })).rejects.toMatchObject({ code: '23514', constraint: 'client_portal_approval_links_expiry_check' });
    await expect(owner()('client_portal_approval_links').insert({
      portal_access_id: s.accessId, client_id: s.clientId, generation: 1, token_hash: 'not-a-hash',
      created_at: owner().raw('now()'), expires_at: owner().raw("now() + interval '1 day'")
    })).rejects.toMatchObject({ code: '23514', constraint: 'client_portal_approval_links_token_hash_check' });
  });

  it('refuses a request: an account bound to the transaction does not issue links', async () => {
    const clientId = await freshClient();
    const access = await newAccess(clientId);
    const content = await awaitingContent(clientId);
    const { itemIds, claimToken } = await claim(access.id, clientId, [content]);
    await expect(asAccount(ids.adminA, (t) => t.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [itemIds, claimToken, newToken().hash])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('worker') });
    expect(await owner()('client_portal_approval_links').where({ portal_access_id: access.id })).toEqual([]);
  });

  it('refuses what is not the e-mail of a live claim: a wrong token, an expired lease, another type, no item, a bad hash', async () => {
    const clientId = await freshClient();
    const access = await newAccess(clientId);
    const content = await awaitingContent(clientId);
    const { itemIds, claimToken } = await claim(access.id, clientId, [content]);
    const refused = { code: 'A0101' };
    await expect(issue(itemIds, randomUUID(), newToken().hash)).rejects.toMatchObject(refused);
    await expect(issue([], claimToken, newToken().hash)).rejects.toMatchObject(refused);
    await expect(issue([randomUUID()], claimToken, newToken().hash)).rejects.toMatchObject(refused);
    await expect(issue(itemIds, claimToken, 'not-a-sha256')).rejects.toMatchObject(refused);
    await expect(issue(itemIds, claimToken, newToken().hash.toUpperCase())).rejects.toMatchObject(refused);

    await owner()('notification_queue').whereIn('id', itemIds).update({ claimed_at: owner().raw("now() - interval '11 minutes'") });
    await expect(issue(itemIds, claimToken, newToken().hash)).rejects.toMatchObject(refused);
    await owner()('notification_queue').whereIn('id', itemIds).update({ claimed_at: owner().raw('now()'), sent_at: owner().raw('now()') });
    await expect(issue(itemIds, claimToken, newToken().hash)).rejects.toMatchObject(refused);
    await owner()('notification_queue').whereIn('id', itemIds).update({ sent_at: null });

    const published = await claim(access.id, clientId, [await awaitingContent(clientId)], 'content_published');
    await expect(issue(published.itemIds, published.claimToken, newToken().hash)).rejects.toMatchObject(refused);
    expect(await owner()('client_portal_approval_links').where({ portal_access_id: access.id })).toEqual([]);
  });

  it('refuses the items of two clients or two mailboxes in one e-mail', async () => {
    const clientOne = await freshClient();
    const clientTwo = await freshClient();
    const one = await newAccess(clientOne);
    const two = await newAccess(clientTwo);
    const claimToken = randomUUID();
    const items: string[] = [];
    for (const [access, client] of [[one, clientOne], [two, clientTwo]] as const) {
      const content = await awaitingContent(client);
      const claimed = await claim(access.id, client, [content]);
      await owner()('notification_queue').whereIn('id', claimed.itemIds).update({ claim_token: claimToken });
      items.push(...claimed.itemIds);
    }
    await expect(issue(items, claimToken, newToken().hash)).rejects.toMatchObject({ code: 'A0101' });

    const sameClient = await freshClient();
    const first = await newAccess(sameClient);
    const second = await newAccess(sameClient);
    const items2: string[] = [];
    for (const access of [first, second]) {
      const claimed = await claim(access.id, sameClient, [await awaitingContent(sameClient)]);
      await owner()('notification_queue').whereIn('id', claimed.itemIds).update({ claim_token: claimToken });
      items2.push(...claimed.itemIds);
    }
    await expect(issue(items2, claimToken, newToken().hash)).rejects.toMatchObject({ code: 'A0101' });
  });

  it('issues one link for two accesses of one mailbox: the first by id, with the contents of both', async () => {
    const clientId = await freshClient();
    const user = randomUUID();
    extraUsers.push(user);
    const address = freshEmail();
    const account = await newAccess(clientId, address);
    // The account that changed its address into the one of another access of the client: two accesses, one mailbox.
    await owner()('auth.user').insert({ id: user, name: 'Duas caixas', email: address, emailVerified: true });
    const other = await newAccess(clientId, freshEmail());
    await owner().transaction(async (transaction) => {
      await transaction('client_portal_accesses').where({ id: other.id }).update({ user_id: user });
      await transaction('client_memberships').insert({ client_id: clientId, user_id: user, portal_access_id: other.id });
    });

    const contentOne = await awaitingContent(clientId);
    const contentTwo = await awaitingContent(clientId);
    const claimToken = randomUUID();
    const itemIds: string[] = [];
    for (const [access, content] of [[account, contentOne], [other, contentTwo]] as const) {
      const claimed = await claim(access.id, clientId, [content]);
      await owner()('notification_queue').whereIn('id', claimed.itemIds).update({ claim_token: claimToken });
      itemIds.push(...claimed.itemIds);
    }
    const { hash } = newToken();
    await issue(itemIds, claimToken, hash);
    const link = await owner()('client_portal_approval_links').where({ token_hash: hash }).first();
    expect(link.portal_access_id).toBe([account.id, other.id].sort()[0]);
    expect((await owner()('client_portal_approval_link_contents').where({ link_id: link.id })).map((row) => row.content_id).sort()).toEqual([contentOne, contentTwo].sort());
  });

  it.each([
    ['the access was removed', async (_clientId: string, accessId: string) => { await owner()('client_portal_accesses').where({ id: accessId }).update({ status: 'removed', generation: 2 }); }],
    ['the client is archived', async (clientId: string) => { await w.archiveClient(clientId); }]
  ])('refuses to issue when %s between the claim and the link', async (_name, change) => {
    const clientId = await freshClient();
    const access = await newAccess(clientId);
    const content = await awaitingContent(clientId);
    const { itemIds, claimToken } = await claim(access.id, clientId, [content]);
    await change(clientId, access.id);
    await expect(issue(itemIds, claimToken, newToken().hash)).rejects.toMatchObject({ code: 'A0101' });
    expect(await owner()('client_portal_approval_links').where({ portal_access_id: access.id })).toEqual([]);
  });

  it('refuses to issue for a suspended agency (A0101) and for a read-only one (A0090, explicit: the trigger lets a write with no actor pass)', async () => {
    const clientId = await freshClient();
    const access = await newAccess(clientId);
    const content = await awaitingContent(clientId);
    const { itemIds, claimToken } = await claim(access.id, clientId, [content]);
    try {
      await setAgencyReadOnly();
      await expect(issue(itemIds, claimToken, newToken().hash)).rejects.toMatchObject({ code: 'A0090' });
      await setAgencyOpen();
      await owner()('agencies').where({ id: ids.agencyA }).update({ status: 'suspended' });
      await expect(issue(itemIds, claimToken, newToken().hash)).rejects.toMatchObject({ code: 'A0101' });
    } finally {
      await setAgencyOpen();
    }
    expect(await owner()('client_portal_approval_links').where({ portal_access_id: access.id })).toEqual([]);
  });
});

// ---- exchanging the token for a session -----------------------------------------------------------------------------------

describe('exchanging the token for a session', () => {
  it('stores the hash of the session, ends it in two hours and never past the link', async () => {
    const s = await scenario({ exchanged: false });
    const session = newToken();
    const before = Date.now();
    const result = await exchange(s.tokenHash, session.hash);
    const hours = (result.session_expires_at.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(1.99);
    expect(hours).toBeLessThan(2.01);
    const row = await owner()('client_portal_approval_sessions').where({ session_hash: session.hash }).first();
    expect(row).toMatchObject({ link_id: s.linkId });
    expect(JSON.stringify(row)).not.toContain(session.token);

    // A link that ends in ten minutes gives a session that ends with it.
    await owner()('client_portal_approval_links').where({ id: s.linkId }).update({
      created_at: owner().raw("now() - interval '6 days 23 hours 50 minutes'"), expires_at: owner().raw("now() + interval '10 minutes'")
    });
    const short = await exchange(s.tokenHash, newToken().hash);
    expect(short.session_expires_at.getTime()).toBe(short.link_expires_at.getTime());
    expect(short.session_expires_at.getTime() - Date.now()).toBeLessThan(10 * 60_000);
  });

  it('answers one error for an unknown token and a malformed one', async () => {
    for (const hash of [sha('unknown'), 'x', '']) {
      await expect(exchange(hash, newToken().hash)).rejects.toMatchObject({ code: 'A0100' });
    }
    const s = await scenario({ exchanged: false });
    await expect(exchange(s.tokenHash, 'not-a-hash')).rejects.toMatchObject({ code: 'A0100' });
    expect(await owner()('client_portal_approval_sessions').where({ link_id: s.linkId })).toEqual([]);
  });

  it('opens nothing for the one who has only the hash of the token: the session is what reads', async () => {
    const s = await scenario({ exchanged: false });
    await expect(batchOf(s.tokenHash)).rejects.toMatchObject({ code: 'A0100' });
    await expect(contentsOf(s.tokenHash)).rejects.toMatchObject({ code: 'A0100' });
  });
});

// ---- the revocation, checked at every use ----------------------------------------------------------------------------------

type Operation = readonly [name: string, run: (s: Scenario) => Promise<unknown>, kind: 'read' | 'write'];
const OPERATIONS: readonly Operation[] = [
  ['exchange the token', (s) => exchange(s.tokenHash, newToken().hash), 'read'],
  ['read the batch', (s) => batchOf(s.sessionHash), 'read'],
  ['read the contents', (s) => contentsOf(s.sessionHash), 'read'],
  ['read the media', (s) => mediaOf(s.sessionHash), 'read'],
  ['approve', (s) => approveBy(s.sessionHash, s.contents[0]!), 'write'],
  ['request changes', (s) => requestBy(s.sessionHash, s.contents[0]!, 'Troque a legenda.'), 'write']
];

interface Revocation {
  readonly name: string;
  readonly apply: (s: Scenario) => Promise<void>;
  readonly restore?: () => Promise<unknown>;
  /** What a write answers when it is not the generic dead link. */
  readonly writeCode?: string;
  /** The session is the thing that ended, so a new exchange still works. */
  readonly sessionOnly?: boolean;
}

const REVOCATIONS: readonly Revocation[] = [
  { name: 'the access was removed', apply: async (s) => { await owner()('client_portal_accesses').where({ id: s.accessId }).update({ status: 'removed', generation: 2 }); } },
  {
    name: 'the access was removed and added again (the generation moved on)',
    apply: async (s) => {
      await owner()('client_portal_accesses').where({ id: s.accessId }).update({ status: 'removed', generation: 2 });
      await owner()('client_portal_accesses').where({ id: s.accessId }).update({ status: 'active' });
    }
  },
  { name: 'the client was archived', apply: async (s) => { await w.archiveClient(s.clientId); } },
  { name: 'the agency was suspended', apply: async () => { await owner()('agencies').where({ id: ids.agencyA }).update({ status: 'suspended' }); }, restore: setAgencyOpen },
  { name: 'the agency is read-only (the trial ended)', apply: async () => { await setAgencyReadOnly(); }, restore: setAgencyOpen, writeCode: 'A0090' },
  {
    name: 'the link expired',
    apply: async (s) => {
      await owner()('client_portal_approval_links').where({ id: s.linkId }).update({
        created_at: owner().raw("now() - interval '8 days'"), expires_at: owner().raw("now() - interval '1 day'")
      });
    }
  },
  {
    name: 'the session expired',
    sessionOnly: true,
    apply: async (s) => {
      await owner()('client_portal_approval_sessions').where({ session_hash: s.sessionHash }).update({
        created_at: owner().raw("now() - interval '3 hours'"), expires_at: owner().raw("now() - interval '1 hour'")
      });
    }
  }
];

describe('the link stops working when its access, client or agency stops allowing it (every use is checked)', () => {
  for (const revocation of REVOCATIONS) {
    describe(`when ${revocation.name}`, () => {
      for (const [name, run, kind] of OPERATIONS) {
        if (revocation.sessionOnly === true && name === 'exchange the token') continue;
        const expected = kind === 'write' && revocation.writeCode !== undefined ? revocation.writeCode : 'A0100';
        it(`refuses to ${name} (${expected}) and writes nothing`, async () => {
          const s = await scenario();
          const before = await contentOf(s.contents[0]!);
          try {
            // The link works until the change: the same call, before it, does not fail with the code asserted below.
            await revocation.apply(s);
            await expect(run(s)).rejects.toMatchObject({ code: expected });
          } finally {
            await revocation.restore?.();
          }
          expect(await contentOf(s.contents[0]!)).toEqual(before);
          expect(await threadsOf(s.contents[0]!)).toEqual([]);
        });
      }
    });
  }

  it('works before any of those changes: the same operations answer', async () => {
    const s = await scenario();
    expect(await batchOf(s.sessionHash)).toHaveLength(1);
    expect(await contentsOf(s.sessionHash)).toHaveLength(2);
    await exchange(s.tokenHash, newToken().hash);
    await approveBy(s.sessionHash, s.contents[0]!);
    await requestBy(s.sessionHash, s.contents[1]!, 'Troque a legenda.');
    expect((await contentOf(s.contents[0]!)).status).toBe('approved');
    expect((await contentOf(s.contents[1]!)).status).toBe('adjusting');
  });

  it('only the link issued after the reactivation is alive: the earlier one and its session stay dead', async () => {
    const s = await scenario();
    await owner()('client_portal_accesses').where({ id: s.accessId }).update({ status: 'removed', generation: 2 });
    await owner()('client_portal_accesses').where({ id: s.accessId }).update({ status: 'active' });
    const content = await awaitingContent(s.clientId);
    const claimed = await claim(s.accessId, s.clientId, [content]);
    const fresh = newToken();
    await issue(claimed.itemIds, claimed.claimToken, fresh.hash);
    const freshSession = newToken();
    await exchange(fresh.hash, freshSession.hash);
    expect((await contentsOf(freshSession.hash)).map((row) => row.id)).toEqual([content]);
    await expect(contentsOf(s.sessionHash)).rejects.toMatchObject({ code: 'A0100' });
    await expect(exchange(s.tokenHash, newToken().hash)).rejects.toMatchObject({ code: 'A0100' });
  });
});

// ---- what the session reads --------------------------------------------------------------------------------------------

describe('what the session reads (the batch and nothing else)', () => {
  it('reads the names, the address of the access and the two expiries, and nothing of the brand', async () => {
    const s = await scenario();
    const [row] = await batchOf(s.sessionHash);
    expect(Object.keys(row!).sort()).toEqual(['agency_id', 'agency_name', 'client_name', 'link_expires_at', 'person_email', 'session_expires_at']);
    expect(row).toMatchObject({ person_email: s.email, agency_id: ids.agencyA });
    expect(row!.client_name).toContain('Aprovação');
  });

  it('reads the contents of its batch and not another content of the same client, of another client or of another link', async () => {
    const s = await scenario({ contents: 2 });
    const outsideSameClient = await awaitingContent(s.clientId);
    const otherClient = await awaitingContent(ids.clientA2);
    const other = await scenario({ contents: 1 });
    const shown = (await contentsOf(s.sessionHash)).map((row) => row.id as string);
    expect([...shown].sort()).toEqual([...s.contents].sort());
    for (const hidden of [outsideSameClient, otherClient, ...other.contents]) expect(shown).not.toContain(hidden);
    expect(Object.keys((await contentsOf(s.sessionHash))[0]!).sort()).toEqual([
      'caption', 'cover_asset_id', 'format', 'id', 'platform', 'publish_at_time', 'publish_on', 'published_on', 'revision', 'status', 'title'
    ]);
  });

  it('shows the current state: one already decided stays with its state, one in production is title, day and format, a cancelled one is gone', async () => {
    const s = await scenario({ contents: 1 });
    const approved = await w.seedContent(s.clientId, { status: 'approved' });
    const adjusting = await w.seedContent(s.clientId, { status: 'adjusting' });
    const production = await w.seedContent(s.clientId, { status: 'in_production', caption: 'Rascunho que o cliente não vê' });
    const cancelled = await w.seedContent(s.clientId, { status: 'cancelled' });
    for (const content of [approved, adjusting, production, cancelled]) {
      await owner()('client_portal_approval_link_contents').insert({ link_id: s.linkId, content_id: content, client_id: s.clientId });
    }
    const shown = new Map((await contentsOf(s.sessionHash)).map((row) => [row.id as string, row]));
    expect(shown.has(cancelled)).toBe(false);
    expect(shown.get(approved)).toMatchObject({ status: 'approved', revision: 1 });
    expect(shown.get(adjusting)).toMatchObject({ status: 'adjusting' });
    expect(shown.get(production)).toMatchObject({ status: 'in_production', revision: null, caption: null, cover_asset_id: null, publish_at_time: null });
    expect(shown.get(s.contents[0]!)).toMatchObject({ status: 'awaiting_approval', caption: 'Legenda original' });
  });

  it('follows a content that came back to awaiting approval: the link still shows it', async () => {
    const s = await scenario({ contents: 1 });
    await approveBy(s.sessionHash, s.contents[0]!);
    expect((await contentsOf(s.sessionHash))[0]).toMatchObject({ status: 'approved' });
    await owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id: s.contents[0]! }).update({ caption: 'Legenda nova' });
    });
    expect((await contentsOf(s.sessionHash))[0]).toMatchObject({ status: 'awaiting_approval', revision: 2, caption: 'Legenda nova' });
  });

  it('reads the files of the preview of its contents: the cover and the media, confirmed and not removed, in the open states', async () => {
    const s = await scenario({ contents: 1 });
    const folder = await w.folderOf(s.clientId);
    const cover = await w.seedAsset(s.clientId, folder);
    const photo = await w.seedAsset(s.clientId, folder);
    const video = await w.seedAsset(s.clientId, folder, { category: 'video' });
    const pending = await w.seedAsset(s.clientId, folder, { status: 'pending' });
    const removed = await w.seedAsset(s.clientId, folder, { removed: true });
    await owner()('contents').where({ id: s.contents[0]! }).update({ cover_asset_id: cover });
    await w.attach(s.contents[0]!, [photo, video, pending, removed]);
    const production = await w.seedContent(s.clientId, { status: 'in_production' });
    await w.attach(production, [await w.seedAsset(s.clientId, folder)]);
    await owner()('client_portal_approval_link_contents').insert({ link_id: s.linkId, content_id: production, client_id: s.clientId });
    // A file of another client that is not in the batch never shows, even attached to nothing of this lot.
    const otherFolder = await w.folderOf(ids.clientA2);
    const foreign = await w.seedContent(ids.clientA2, { status: 'awaiting_approval' });
    await w.attach(foreign, [await w.seedAsset(ids.clientA2, otherFolder)]);

    const media = await mediaOf(s.sessionHash);
    expect(media.map((row) => [row.content_id, row.asset_id, row.role]).sort()).toEqual(
      [[s.contents[0], cover, 'cover'], [s.contents[0], photo, 'media'], [s.contents[0], video, 'media']].sort()
    );
    expect(Object.keys(media[0]!).sort()).toEqual(['asset_id', 'category', 'content_id', 'extension', 'item_position', 'role', 'thumbnail_object_key', 'video_processing_status']);
  });

  it('decides nothing by being read: exchanging, reading the batch, the contents and the media leave every content as it was', async () => {
    const s = await scenario({ exchanged: false });
    const before = await Promise.all(s.contents.map(contentOf));
    await exchange(s.tokenHash, s.sessionHash);
    await batchOf(s.sessionHash);
    await contentsOf(s.sessionHash);
    await mediaOf(s.sessionHash);
    expect(await Promise.all(s.contents.map(contentOf))).toEqual(before);
    expect(await owner()('client_threads').where({ client_id: s.clientId })).toEqual([]);
    expect(await owner()('client_thread_comments').where({ client_id: s.clientId })).toEqual([]);
  });
});

// ---- deciding as the access ----------------------------------------------------------------------------------------------

describe('Aprovar, as the access of the link', () => {
  it('approves as the access: status, the access as approver, no account, the time of the database', async () => {
    const s = await scenario();
    const before = Date.now();
    await approveBy(s.sessionHash, s.contents[0]!);
    const row = await contentOf(s.contents[0]!);
    expect(row).toMatchObject({ status: 'approved', approved_by: null, approved_by_portal_access_id: s.accessId, approved_by_agency_reason: null });
    expect(Math.abs(new Date(row.approved_at).getTime() - before)).toBeLessThan(10_000);
    expect((await contentOf(s.contents[1]!)).status).toBe('awaiting_approval');
  });

  it('leaves no context behind: the transaction ends with nothing bound, and the next write is not the access', async () => {
    const s = await scenario({ contents: 3 });
    await approveBy(s.sessionHash, s.contents[0]!);
    expect((await owner().raw<{ rows: Array<{ n: string }> }>('select count(*)::text as n from app_private.portal_approval_context where access_id = ?::uuid', [s.accessId])).rows[0]!.n).toBe('0');
    // In the same transaction, after a decision, a plain approval has no access to borrow: the guard refuses it.
    await expect(owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [s.sessionHash, s.contents[1]!]);
      await transaction('contents').where({ id: s.contents[2]! }).update({ status: 'approved' });
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('approved by a person') });
    expect((await contentOf(s.contents[1]!)).status).toBe('awaiting_approval');
    expect((await contentOf(s.contents[2]!)).status).toBe('awaiting_approval');
    const decidedTwice = await scenario();
    await asApp(async (transaction) => {
      await transaction.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [decidedTwice.sessionHash, decidedTwice.contents[0]!]);
      await transaction.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [decidedTwice.sessionHash, decidedTwice.contents[1]!]);
    });
    for (const content of decidedTwice.contents) expect(await contentOf(content)).toMatchObject({ status: 'approved', approved_by_portal_access_id: decidedTwice.accessId });
  });

  it('is idempotent: a content already approved stays as the first approval left it', async () => {
    const s = await scenario();
    const second = await scenario({ clientId: s.clientId });
    await approveBy(s.sessionHash, s.contents[0]!);
    const first = await contentOf(s.contents[0]!);
    // The other person of the same client, with their own link to the same content.
    await owner()('client_portal_approval_link_contents').insert({ link_id: second.linkId, content_id: s.contents[0]!, client_id: s.clientId });
    await approveBy(second.sessionHash, s.contents[0]!, 99);
    expect(await contentOf(s.contents[0]!)).toEqual(first);
  });

  it.each(['adjusting', 'published', 'in_production'] as const)('refuses a content that is %s: only a content awaiting approval is decided (A0062)', async (status) => {
    const s = await scenario({ contents: 1 });
    const target = await w.seedContent(s.clientId, { status });
    await owner()('client_portal_approval_link_contents').insert({ link_id: s.linkId, content_id: target, client_id: s.clientId });
    const before = await contentOf(target);
    await expect(approveBy(s.sessionHash, target)).rejects.toMatchObject({ code: 'A0062' });
    await expect(requestBy(s.sessionHash, target, 'Troque.')).rejects.toMatchObject({ code: 'A0062' });
    expect(await contentOf(target)).toEqual(before);
    expect(await threadsOf(target)).toEqual([]);
  });

  it('refuses a cancelled content as not found, and an absent one', async () => {
    const s = await scenario({ contents: 1 });
    const cancelled = await w.seedContent(s.clientId, { status: 'cancelled' });
    await owner()('client_portal_approval_link_contents').insert({ link_id: s.linkId, content_id: cancelled, client_id: s.clientId });
    for (const target of [cancelled, randomUUID()]) {
      await expect(approveBy(s.sessionHash, target)).rejects.toMatchObject({ code: 'A0060' });
      await expect(requestBy(s.sessionHash, target, 'Troque.')).rejects.toMatchObject({ code: 'A0060' });
    }
  });

  it('refuses a content outside the batch (A0060): the same client, another client, the batch of another link', async () => {
    const s = await scenario({ contents: 1 });
    const sameClient = await awaitingContent(s.clientId);
    const otherClient = await awaitingContent(ids.clientA2);
    const otherLink = await scenario({ contents: 1 });
    for (const target of [sameClient, otherClient, ...otherLink.contents]) {
      const before = await contentOf(target);
      await expect(approveBy(s.sessionHash, target)).rejects.toMatchObject({ code: 'A0060' });
      await expect(requestBy(s.sessionHash, target, 'Troque.')).rejects.toMatchObject({ code: 'A0060' });
      expect(await contentOf(target)).toEqual(before);
      expect(await threadsOf(target)).toEqual([]);
    }
  });

  it('refuses a revision that is not the one read (A0063) and a session of nobody', async () => {
    const s = await scenario({ contents: 1 });
    await expect(approveBy(s.sessionHash, s.contents[0]!, 2)).rejects.toMatchObject({ code: 'A0063' });
    await expect(requestBy(s.sessionHash, s.contents[0]!, 'Troque.', 0)).rejects.toMatchObject({ code: 'A0063' });
    await expect(approveBy(sha('nobody'), s.contents[0]!)).rejects.toMatchObject({ code: 'A0100' });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('refuses an account bound to the transaction: the link is the door of the one with no login', async () => {
    const s = await scenario({ contents: 1 });
    // The message is the function's own: the guard of contents refuses an account and a link at once with another one.
    await expect(asAccount(ids.adminA, (t) => t.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [s.sessionHash, s.contents[0]!])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('no account bound') });
    await expect(asAccount(ids.adminA, (t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, 1, ?)', [s.sessionHash, s.contents[0]!, 'Troque.'])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('no account bound') });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
  });
});

describe('Pedir ajuste, as the access of the link', () => {
  it('moves the content to adjusting and writes the comment as the access, on the client side, in a conversation the access opened', async () => {
    const s = await scenario();
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque a legenda, por favor.');
    expect((await contentOf(s.contents[0]!)).status).toBe('adjusting');
    expect((await contentOf(s.contents[0]!)).approved_by_portal_access_id).toBeNull();
    const [thread] = await threadsOf(s.contents[0]!);
    expect(thread).toMatchObject({ client_id: s.clientId, opened_by: null, opened_by_portal_access_id: s.accessId, opened_side: 'client', resolved_at: null });
    const comments = await commentsOfThread(thread!.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      client_id: s.clientId, author_user_id: null, author_portal_access_id: s.accessId, author_side: 'client', body: 'Troque a legenda, por favor.'
    });
    expect((await contentOf(s.contents[1]!)).status).toBe('awaiting_approval');
  });

  it('writes into the conversation the agency already opened, and reopens it when it was resolved', async () => {
    const s = await scenario({ contents: 1 });
    await owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('client_threads').insert({ client_id: s.clientId, content_id: s.contents[0]!, opened_by: ids.adminA, opened_side: 'agency' });
    });
    await owner()('client_threads').where({ content_id: s.contents[0]! }).update({ resolved_by: ids.adminA, resolved_at: owner().fn.now() });
    await requestBy(s.sessionHash, s.contents[0]!, 'Ainda falta o logo.');
    const [thread] = await threadsOf(s.contents[0]!);
    expect(thread).toMatchObject({ opened_by: ids.adminA, opened_by_portal_access_id: null, opened_side: 'agency', resolved_at: null, resolved_by: null });
    expect(await commentsOfThread(thread!.id)).toEqual([expect.objectContaining({ author_portal_access_id: s.accessId, author_side: 'client' })]);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   \n\t '],
    ['zero-width characters', '​‍﻿'],
    ['a control character', '\u0007\u0001'],
    ['more than 5000 bytes', 'ç'.repeat(2501)]
  ])('refuses a comment that is %s (A0068) and leaves nothing: no conversation, no state', async (_name, comment) => {
    const s = await scenario({ contents: 1 });
    await expect(requestBy(s.sessionHash, s.contents[0]!, comment)).rejects.toMatchObject({ code: 'A0068' });
    await expect(asApp((t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, 1, null)', [s.sessionHash, s.contents[0]!]))).rejects.toMatchObject({ code: 'A0068' });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(s.contents[0]!)).toEqual([]);
  });

  it('accepts exactly 5000 bytes', async () => {
    const s = await scenario({ contents: 1 });
    await requestBy(s.sessionHash, s.contents[0]!, 'ç'.repeat(2500));
    expect((await contentOf(s.contents[0]!)).status).toBe('adjusting');
  });

  it('is atomic: when the last step fails, no conversation and no comment are left', async () => {
    const s = await scenario({ contents: 1 });
    const trigger = `fail_after_comment_${randomUUID().replaceAll('-', '')}`;
    await owner().raw(`
      create function public.${trigger}() returns trigger language plpgsql as $f$ begin raise exception using errcode = 'P0001', message = 'injected'; end; $f$;
      create trigger ${trigger} before update on public.contents for each row when (new.status = 'adjusting') execute function public.${trigger}();
    `);
    try {
      await expect(requestBy(s.sessionHash, s.contents[0]!, 'Troque.')).rejects.toMatchObject({ message: expect.stringContaining('injected') });
    } finally {
      await owner().raw(`drop trigger ${trigger} on public.contents; drop function public.${trigger}();`);
    }
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(s.contents[0]!)).toEqual([]);
    expect(await owner()('client_thread_comments').where({ client_id: s.clientId })).toEqual([]);
  });
});

// ---- the same effect and the same refusals as the portal ---------------------------------------------------------------------

describe('parity with the approval by the account in the portal', () => {
  const portalApprove = (user: string, contentId: string, revision = 1): Promise<unknown> =>
    asAccount(user, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer)', [contentId, revision]));
  const portalRequest = (user: string, contentId: string, comment: string, revision = 1): Promise<unknown> =>
    asAccount(user, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?)', [contentId, revision, comment]));
  const comparable = (row: Row): Row => ({
    ...without(row, 'id', 'approved_by', 'approved_by_portal_access_id', 'approved_at', 'created_at', 'updated_at', 'title'),
    approved: row.approved_by !== null || row.approved_by_portal_access_id !== null,
    hasApprovedAt: row.approved_at !== null
  });

  it('leaves the content in the same state as the account does, but for who approved', async () => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    const twin = await awaitingContent(s.clientId);
    await portalApprove(user, twin);
    await approveBy(s.sessionHash, s.contents[0]!);
    const byLink = await contentOf(s.contents[0]!);
    const byAccount = await contentOf(twin);
    expect(comparable(byLink)).toEqual(comparable(byAccount));
    expect(byAccount).toMatchObject({ approved_by: user, approved_by_portal_access_id: null });
    expect(byLink).toMatchObject({ approved_by: null, approved_by_portal_access_id: s.accessId });
  });

  it('writes the same request for changes as the account does, but for who wrote it', async () => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    const twin = await awaitingContent(s.clientId);
    await portalRequest(user, twin, 'Troque a legenda.');
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque a legenda.');
    const [accountThread] = await threadsOf(twin);
    const [linkThread] = await threadsOf(s.contents[0]!);
    const apart = ['id', 'content_id', 'created_at', 'opened_by', 'opened_by_portal_access_id'];
    expect(without(linkThread!, ...apart)).toEqual(without(accountThread!, ...apart));
    expect([accountThread!.opened_by, accountThread!.opened_by_portal_access_id]).toEqual([user, null]);
    expect([linkThread!.opened_by, linkThread!.opened_by_portal_access_id]).toEqual([null, s.accessId]);
    const [accountComment] = await commentsOfThread(accountThread!.id);
    const [linkComment] = await commentsOfThread(linkThread!.id);
    expect(linkComment).toMatchObject({ author_side: accountComment!.author_side, body: accountComment!.body });
    expect(comparable(await contentOf(s.contents[0]!))).toEqual(comparable(await contentOf(twin)));
  });

  const refusals: Array<[string, ContentStatus, string]> = [
    ['adjusting', 'adjusting', 'A0062'],
    ['published', 'published', 'A0062'],
    ['cancelled', 'cancelled', 'A0060']
  ];
  it.each(refusals)('refuses an approval of a %s content with the same code as the portal (%s)', async (_name, status, code) => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    const target = await w.seedContent(s.clientId, { status });
    await owner()('client_portal_approval_link_contents').insert({ link_id: s.linkId, content_id: target, client_id: s.clientId });
    await expect(portalApprove(user, target)).rejects.toMatchObject({ code });
    await expect(approveBy(s.sessionHash, target)).rejects.toMatchObject({ code });
  });

  it('answers the same code for a stale revision, a blank comment and a content it cannot see', async () => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    const twin = await awaitingContent(s.clientId);
    await expect(portalApprove(user, twin, 7)).rejects.toMatchObject({ code: 'A0063' });
    await expect(approveBy(s.sessionHash, s.contents[0]!, 7)).rejects.toMatchObject({ code: 'A0063' });
    await expect(portalRequest(user, twin, '  ')).rejects.toMatchObject({ code: 'A0068' });
    await expect(requestBy(s.sessionHash, s.contents[0]!, '  ')).rejects.toMatchObject({ code: 'A0068' });
    const absent = randomUUID();
    await expect(portalApprove(user, absent)).rejects.toMatchObject({ code: 'A0060' });
    await expect(approveBy(s.sessionHash, absent)).rejects.toMatchObject({ code: 'A0060' });
  });
});

// ---- the authorship is the link's alone ------------------------------------------------------------------------------------

describe('the authorship of an access is written only inside the decision of its link', () => {
  it('refuses to approve as an access outside the function: the guard of contents (owner, no context, no account)', async () => {
    const s = await scenario({ contents: 1 });
    await expect(owner()('contents').where({ id: s.contents[0]! }).update({ status: 'approved' })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('approved by a person')
    });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('does not take the access from the row: an UPDATE that names it, with no decision of a link, is refused', async () => {
    const s = await scenario({ contents: 1 });
    await expect(owner()('contents').where({ id: s.contents[0]! }).update({ status: 'approved', approved_by_portal_access_id: s.accessId })).rejects.toMatchObject({
      code: '42501', message: expect.stringContaining('approved by a person')
    });
    await expect(owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id: s.contents[0]! }).update({ status: 'approved', approved_by_portal_access_id: s.accessId });
    })).resolves.toBeUndefined();
    // With an account bound the access the caller named is thrown away: the account is the approver.
    expect(await contentOf(s.contents[0]!)).toMatchObject({ approved_by: ids.adminA, approved_by_portal_access_id: null });
  });

  it('fixes the access column to null when an account approves: the caller never chooses who approved', async () => {
    const s = await scenario({ contents: 1 });
    await owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id: s.contents[0]! }).update({ status: 'approved' });
    });
    expect(await contentOf(s.contents[0]!)).toMatchObject({ approved_by: ids.adminA, approved_by_portal_access_id: null });
  });

  it('ignores a setting posted by the application: a transaction variable proves nothing, and the account stays the author', async () => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    const twin = await awaitingContent(s.clientId);
    await asAccount(user, async (transaction) => {
      await transaction.raw("select set_config('app.portal_approval_access_id', ?, true), set_config('app.portal_approval_link_id', ?, true)", [s.accessId, s.linkId]);
      await transaction.raw('select app_private.approve_content(?::uuid, 1)', [twin]);
    });
    expect(await contentOf(twin)).toMatchObject({ approved_by: user, approved_by_portal_access_id: null });
    // And with no account at all the setting buys nothing: there is no approver, so the guard refuses.
    await expect(asApp(async (transaction) => {
      await transaction.raw("select set_config('app.portal_approval_access_id', ?, true)", [s.accessId]);
      await transaction.raw('select app_private.approve_content(?::uuid, 1)', [s.contents[0]!]);
    })).rejects.toMatchObject({ code: 'A0060' });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('refuses a comment or a conversation written as an access outside the decision (the guards of the two tables)', async () => {
    const s = await scenario({ contents: 1 });
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque.');
    const [thread] = await threadsOf(s.contents[0]!);
    await expect(owner()('client_thread_comments').insert({
      thread_id: thread!.id, client_id: s.clientId, author_portal_access_id: s.accessId, author_side: 'client', body: 'Forjado'
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('only through its approval link') });
    const other = await awaitingContent(s.clientId);
    await expect(owner()('client_threads').insert({
      client_id: s.clientId, content_id: other, opened_by_portal_access_id: s.accessId, opened_side: 'client'
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('only through its approval link') });
    expect(await commentsOfThread(thread!.id)).toHaveLength(1);
    expect(await threadsOf(other)).toEqual([]);
  });

  it('refuses a comment of an access as the application role: no grant on the column, the account cannot choose the author', async () => {
    const s = await scenario({ contents: 1 });
    const user = await joinPortal(s.clientId);
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque.');
    const [thread] = await threadsOf(s.contents[0]!);
    await expect(asAccount(user, (t) => t('client_thread_comments').insert({
      thread_id: thread!.id, client_id: s.clientId, author_user_id: user, author_portal_access_id: s.accessId, author_side: 'client', body: 'Forjado'
    }))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    expect(await w.columnsWithPrivilege('client_thread_comments', 'insert')).not.toContain('author_portal_access_id');
    expect(await w.columnsWithPrivilege('client_threads', 'insert')).not.toContain('opened_by_portal_access_id');
  });

  it('keeps the shape of the authorship: one author per comment, one opener per conversation, an access only on the client side', async () => {
    const s = await scenario({ contents: 1 });
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque.');
    const [thread] = await threadsOf(s.contents[0]!);
    const comment = (await commentsOfThread(thread!.id))[0]!;
    await expect(owner()('client_thread_comments').where({ id: comment.id }).update({ author_user_id: ids.adminA }))
      .rejects.toMatchObject({ code: '23514', constraint: 'client_thread_comments_one_author_check' });
    await expect(owner()('client_threads').where({ id: thread!.id }).update({ opened_by: ids.adminA }))
      .rejects.toMatchObject({ code: '23514', constraint: 'client_threads_one_opener_check' });
    await expect(owner()('client_threads').where({ id: thread!.id }).update({ opened_side: 'agency' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'client_threads_access_opens_content_check' });
  });

});

// ---- who sees which name -----------------------------------------------------------------------------------------------------

describe('the label of an access shows the name of the account only after the account entered that portal', () => {
  const label = (user: string, accessId: string, clientId: string): Promise<string | null> =>
    asAccount(user, async (t) => (await t.raw<{ rows: Array<{ label: string | null }> }>('select app_private.portal_access_label(?::uuid, ?::uuid) as label', [accessId, clientId])).rows[0]!.label);

  it('shows the address while first_entered_at is null, even with an account linked, and the name after', async () => {
    const clientId = await freshClient();
    const user = randomUUID();
    extraUsers.push(user);
    const email = freshEmail();
    await owner()('auth.user').insert({ id: user, name: 'Maria da Conta', email, emailVerified: true });
    await owner()('client_memberships').insert({ client_id: clientId, user_id: user });
    const access = (await owner()('client_portal_accesses').where({ client_id: clientId, user_id: user }).first())!;
    await owner()('client_portal_accesses').where({ id: access.id }).update({ first_entered_at: null });
    expect(await label(ids.adminA, access.id, clientId)).toBe(access.email);
    await owner()('client_portal_accesses').where({ id: access.id }).update({ first_entered_at: owner().fn.now() });
    expect(await label(ids.adminA, access.id, clientId)).toBe('Maria da Conta');
  });

  it('shows the same in the authors of a conversation: the address of an access that did not enter, and no photo', async () => {
    const s = await scenario({ contents: 1 });
    const user = randomUUID();
    extraUsers.push(user);
    await owner()('auth.user').insert({ id: user, name: 'Nome da Conta', email: freshEmail(), emailVerified: true, image: 'identity/foto.png' });
    await owner().transaction(async (transaction) => {
      await transaction('client_portal_accesses').where({ id: s.accessId }).update({ user_id: user, first_entered_at: null });
      await transaction('client_memberships').insert({ client_id: s.clientId, user_id: user, portal_access_id: s.accessId });
    });
    await requestBy(s.sessionHash, s.contents[0]!, 'Troque.');
    const [thread] = await threadsOf(s.contents[0]!);
    const authors = (id: string): Promise<Array<Record<string, unknown>>> =>
      asAccount(id, async (t) => (await t.raw<{ rows: Array<Record<string, unknown>> }>('select * from app_private.thread_comment_authors(?::uuid)', [thread!.id])).rows);
    expect(await authors(ids.adminA)).toEqual([expect.objectContaining({ author_portal_access_id: s.accessId, name: s.email, photo_key: null })]);
    await owner()('client_portal_accesses').where({ id: s.accessId }).update({ first_entered_at: owner().fn.now() });
    expect(await authors(ids.adminA)).toEqual([expect.objectContaining({ author_portal_access_id: s.accessId, name: 'Nome da Conta', photo_key: 'identity/foto.png' })]);
  });
});

// ---- only READ COMMITTED -------------------------------------------------------------------------------------------------------------

describe('the writes of the link refuse another isolation level (the judgment after the wait only sees the commit in READ COMMITTED)', () => {
  const inLevel = async (level: 'repeatable read' | 'serializable', work: (transaction: Knex.Transaction) => Promise<unknown>): Promise<unknown> => {
    const transaction = await worker.knex.transaction({ isolationLevel: level });
    try {
      await work(transaction);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  };

  it.each(['repeatable read', 'serializable'] as const)('answers 40001 in %s to the exchange, to Aprovar and to Pedir ajuste, and writes nothing', async (level) => {
    const s = await scenario({ contents: 2, exchanged: false });
    const session = newToken().hash;
    await expect(inLevel(level, (t) => t.raw('select * from app_private.exchange_portal_approval_token(?, ?)', [s.tokenHash, session]))).rejects.toMatchObject({ code: '40001' });
    expect(await owner()('client_portal_approval_sessions').where({ link_id: s.linkId })).toEqual([]);

    await exchange(s.tokenHash, s.sessionHash);
    await expect(inLevel(level, (t) => t.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [s.sessionHash, s.contents[0]!]))).rejects.toMatchObject({ code: '40001' });
    await expect(inLevel(level, (t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, 1, ?)', [s.sessionHash, s.contents[1]!, 'Troque.']))).rejects.toMatchObject({ code: '40001' });
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
    expect((await contentOf(s.contents[1]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(s.contents[1]!)).toEqual([]);
  });
});

// ---- a decision waits for the removal or the archive in flight ----------------------------------------------------------------

describe('a decision and a removal or an archive racing for the same access', () => {
  it('waits for the removal in flight and is refused after it, approving nothing', async () => {
    const s = await scenario({ contents: 1 });
    const removal = await owner().transaction();
    await removal('client_portal_accesses').where({ id: s.accessId }).update({ status: 'removed', generation: 2 });
    const approval = approveBy(s.sessionHash, s.contents[0]!).then(() => 'approved', (error: { code?: string }) => error.code);
    await w.waitUntilSomeoneWaitsOnALock();
    await removal.commit();
    expect(await approval).toBe('A0100');
    expect((await contentOf(s.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('waits for the archive in flight and is refused after it, approving nothing', async () => {
    const s = await scenario({ contents: 1 });
    const archive = await owner().transaction();
    await archive('clients').where({ id: s.clientId }).update({ status: 'archived', archived_at: archive.fn.now() });
    const request = requestBy(s.sessionHash, s.contents[0]!, 'Troque.').then(() => 'requested', (error: { code?: string }) => error.code);
    await w.waitUntilSomeoneWaitsOnALock();
    await archive.commit();
    expect(await request).toBe('A0100');
    expect(await threadsOf(s.contents[0]!)).toEqual([]);
  });
});
