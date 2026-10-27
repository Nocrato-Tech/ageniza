import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureLogs, TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import type { MediaStorageClient } from '../media/storage-client.js';
import { createPortalFixtures } from '../contents/test-support/portal-fixtures.js';
import { createContentsWorld, type Reply } from '../contents/test-support/world.js';
import { APPROVAL_COOKIE_NAME } from './policy.js';

// Issue #712 (decision 2026-10-26, "o e-mail de aprovação leva um link que aprova sem login"), over HTTP. The database tests prove the
// functions; these prove what the routes add: the token only in the body of a POST, a cookie that is not an account session, `no-store`
// on every answer, the same effects and refusals as the portal, the limits by IP and by token, and nothing of the token in a log.
// Every test calls from an address of its own (`remoteAddress`), so the limit of one never counts against another.
const logs = captureLogs('debug');
const signing = { expiresInSeconds: [] as number[] };
const recordingStorage = (storage: MediaStorageClient): MediaStorageClient => ({
  ...storage,
  presignGetObject: async (input) => {
    signing.expiresInSeconds.push(input.expiresInSeconds);
    return storage.presignGetObject(input);
  }
});

const w = createContentsWorld('approval');
const p = createPortalFixtures(w);
const { people } = w;

const origin = { origin: TEST_APP_PUBLIC_URL };
let addressCounter = 10;
const freshAddress = (): string => `198.51.100.${(addressCounter += 1)}`;

type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const newToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha(token) };
};
const owner = () => w.getOwner().knex;

interface Link {
  readonly clientId: string;
  readonly accessId: string;
  readonly email: string;
  readonly token: string;
  readonly linkId: string;
  readonly contents: string[];
  readonly address: string;
  /** The `Cookie` header of the approval session, once the token was exchanged. */
  cookie: string;
}

const claimAndIssue = async (accessId: string, clientId: string, contentIds: readonly string[]): Promise<{ token: string; linkId: string }> => {
  const claimToken = randomUUID();
  const itemIds: string[] = [];
  for (const contentId of contentIds) {
    const result = await owner().raw<{ rows: Array<{ id: string }> }>(`
      insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
      values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1)
      on conflict (type, content_id, recipient_portal_access_id) where sent_at is null and discarded_at is null
      do update set claimed_at = now(), claim_token = excluded.claim_token
      returning id
    `, [clientId, accessId, contentId, claimToken]);
    itemIds.push(result.rows[0]!.id);
  }
  const { token, hash } = newToken();
  await owner().raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [itemIds, claimToken, hash]);
  const link = await owner()('client_portal_approval_links').where({ token_hash: hash }).first('id');
  return { token, linkId: link!.id as string };
};

/** A client with an access, `count` contents awaiting approval and the link of their e-mail. */
const newLink = async (options: { count?: number; clientId?: string; email?: string; statuses?: Status[] } = {}): Promise<Link> => {
  const clientId = options.clientId ?? await w.newClient('approval-link');
  const email = options.email ?? `${randomUUID()}@approval-address.test`;
  const [access] = await owner()('client_portal_accesses').insert({ client_id: clientId, email }).returning('id');
  const contents: string[] = [];
  for (let index = 0; index < (options.count ?? 2); index += 1) {
    contents.push(await w.seedContent(clientId, { status: options.statuses?.[index] ?? 'awaiting_approval', publishOn: `2026-10-${String(20 + index).padStart(2, '0')}` }));
  }
  const { token, linkId } = await claimAndIssue(access!.id as string, clientId, contents);
  return { clientId, accessId: access!.id as string, email, token, linkId, contents, address: freshAddress(), cookie: '' };
};

const call = async (
  method: 'GET' | 'POST' | 'HEAD',
  url: string,
  options: { payload?: unknown; cookie?: string; address?: string; headers?: Record<string, string> } = {}
): Promise<Reply & { headers: Record<string, unknown>; body: string; cookies: Array<{ name: string; value: string }>; rawHeaders: Record<string, unknown> }> =>
  (await w.getApp().app.inject({
    method,
    url,
    remoteAddress: options.address ?? freshAddress(),
    headers: { ...(method === 'POST' ? origin : {}), ...(options.cookie === undefined ? {} : { cookie: options.cookie }), ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload as Record<string, unknown> })
  })) as never;

const exchange = async (link: Link): Promise<Awaited<ReturnType<typeof call>>> => {
  const reply = await call('POST', '/portal-approval/session', { payload: { token: link.token }, address: link.address });
  if (reply.statusCode === 200) link.cookie = `${APPROVAL_COOKIE_NAME}=${reply.cookies.find((cookie) => cookie.name === APPROVAL_COOKIE_NAME)!.value}`;
  return reply;
};

const withSession = async (options: Parameters<typeof newLink>[0] = {}): Promise<Link> => {
  const link = await newLink(options);
  const reply = await exchange(link);
  expect(reply.statusCode).toBe(200);
  return link;
};

const batch = (link: Link) => call('GET', '/portal-approval/batch', { cookie: link.cookie, address: link.address });
const approve = (link: Link, contentId: string, revision = 1) =>
  call('POST', `/portal-approval/contents/${contentId}/approve`, { cookie: link.cookie, payload: { revision }, address: link.address });
const requestChanges = (link: Link, contentId: string, comment: string, revision = 1) =>
  call('POST', `/portal-approval/contents/${contentId}/request-changes`, { cookie: link.cookie, payload: { revision, comment }, address: link.address });

const errorOf = (reply: { json<T>(): T }): { code?: string; message?: string } => reply.json<{ error?: { code?: string; message?: string } }>().error ?? {};
// A row or a body as the test reads it: by column or field name, with the shape asserted where it matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper over untyped rows
type Row = Record<string, any>;
const without = (value: Row, ...keys: readonly string[]): Row => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const row = (id: string): Promise<Row> => w.contentRow(id) as Promise<Row>;
const threadsOf = (contentId: string): Promise<Row[]> => owner()('client_threads').where({ content_id: contentId });

beforeAll(async () => {
  await w.setup({ logger: logs.logger, wrapMediaStorage: recordingStorage });
  await p.setup();
}, 120_000);

afterAll(async () => {
  await owner()('notification_queue').whereIn('client_id', (await owner()('clients').whereIn('agency_id', [w.agencyA, w.agencyB]).select('id')).map((client) => client.id as string)).delete();
  await p.cleanup();
  await w.teardown();
}, 60_000);

// ---- the exchange -------------------------------------------------------------------------------------------------------

describe('POST /portal-approval/session: the token for the cookie', () => {
  it('answers with the cookie of the approval session: HttpOnly, SameSite=Strict, restricted to the routes of the link, short and no-store', async () => {
    const link = await newLink();
    const before = Date.now();
    const reply = await call('POST', '/portal-approval/session', { payload: { token: link.token }, address: link.address });

    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ sessionExpiresAt: string; linkExpiresAt: string }>();
    expect(Object.keys(body).sort()).toEqual(['linkExpiresAt', 'sessionExpiresAt']);
    const linkLife = (new Date(body.linkExpiresAt).getTime() - before) / 86_400_000;
    expect(linkLife).toBeGreaterThan(6.9);
    expect(linkLife).toBeLessThan(7.1);
    const sessionLife = (new Date(body.sessionExpiresAt).getTime() - before) / 3_600_000;
    expect(sessionLife).toBeGreaterThan(1.9);
    expect(sessionLife).toBeLessThan(2.1);

    const header = [reply.headers['set-cookie']].flat().join('\n');
    expect(header).toMatch(new RegExp(`^${APPROVAL_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
    expect(header).toContain('Path=/portal-approval');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)![1]);
    expect(maxAge).toBeGreaterThan(7_000);
    expect(maxAge).toBeLessThanOrEqual(7_200);
    expect(header).not.toContain('Domain=');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('puts the hash of the session in the database and neither the session nor the token', async () => {
    const link = await newLink();
    const reply = await exchange(link);
    const sessionToken = link.cookie.split('=')[1]!;

    const sessions = await owner()('client_portal_approval_sessions').where({ link_id: link.linkId });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_hash).toBe(sha(sessionToken));
    expect(JSON.stringify(sessions)).not.toContain(sessionToken);
    expect(JSON.stringify(await owner()('client_portal_approval_links').where({ id: link.linkId }))).not.toContain(link.token);
    expect(reply.body).not.toContain(link.token);
    expect(reply.body).not.toContain(sessionToken);
    expect(link.cookie).not.toContain(link.token);
  });

  it('answers the same 404 for an unknown token, with no cookie, no matter what the token is', async () => {
    const reply = await call('POST', '/portal-approval/session', { payload: { token: newToken().token } });
    expect(reply.statusCode).toBe(404);
    expect(errorOf(reply).code).toBe('APPROVAL_LINK_INVALID');
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('refuses a token in the query: a URL reaches logs and proxies, so any parameter is a 400 and creates no session', async () => {
    const link = await newLink();
    for (const url of [
      `/portal-approval/session?token=${link.token}`,
      `/portal-approval/session?t=${link.token}`,
      '/portal-approval/session?anything=1'
    ]) {
      const reply = await call('POST', url, { payload: { token: link.token }, address: link.address });
      expect(reply.statusCode, url).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
      expect(reply.headers['set-cookie']).toBeUndefined();
      expect(reply.body).not.toContain(link.token);
    }
    // A token only in the query, with an empty body, is the same 400.
    const onlyQuery = await call('POST', `/portal-approval/session?token=${link.token}`, { payload: {}, address: link.address });
    expect(onlyQuery.statusCode).toBe(400);
    expect(await owner()('client_portal_approval_sessions').where({ link_id: link.linkId })).toEqual([]);
    // The control: the same token in the body works.
    expect((await exchange(link)).statusCode).toBe(200);
  });

  it('refuses a malformed token, an extra field and a missing body before the database', async () => {
    const link = await newLink();
    for (const payload of [{ token: 'curto' }, { token: `${link.token}x` }, { token: 123 }, {}, { token: link.token, extra: true }, { token: `${link.token.slice(0, 42)}=` }]) {
      const reply = await call('POST', '/portal-approval/session', { payload, address: link.address });
      expect(reply.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
    }
    expect(await owner()('client_portal_approval_sessions').where({ link_id: link.linkId })).toEqual([]);
  });

  it('is a POST from the origin of the app: no origin, or another one, is the CSRF refusal', async () => {
    const link = await newLink();
    const none = await w.getApp().app.inject({ method: 'POST', url: '/portal-approval/session', remoteAddress: link.address, payload: { token: link.token } });
    expect(none.statusCode).toBe(403);
    const other = await w.getApp().app.inject({ method: 'POST', url: '/portal-approval/session', remoteAddress: link.address, headers: { origin: 'https://evil.example' }, payload: { token: link.token } });
    expect(other.statusCode).toBe(403);
    expect((await w.getApp().app.inject({ method: 'GET', url: '/portal-approval/session', remoteAddress: link.address })).statusCode).toBe(404);
    expect(await owner()('client_portal_approval_sessions').where({ link_id: link.linkId })).toEqual([]);
  });
});

// ---- opening decides nothing ------------------------------------------------------------------------------------------------

describe('opening the link decides nothing (only a POST decides)', () => {
  it('leaves every content, conversation and approval as it was after the exchange and any number of reads', async () => {
    const link = await withSession({ count: 3 });
    const before = await Promise.all(link.contents.map(row));
    for (let read = 0; read < 3; read += 1) expect((await batch(link)).statusCode).toBe(200);
    expect(await Promise.all(link.contents.map(row))).toEqual(before);
    expect(await owner()('client_threads').where({ client_id: link.clientId })).toEqual([]);
    expect(await owner()('client_thread_comments').where({ client_id: link.clientId })).toEqual([]);
  });

  it('does not answer a GET or a HEAD on the routes that decide', async () => {
    const link = await withSession({ count: 1 });
    for (const method of ['GET', 'HEAD'] as const) {
      for (const action of ['approve', 'request-changes']) {
        const reply = await call(method, `/portal-approval/contents/${link.contents[0]}/${action}`, { cookie: link.cookie, address: link.address });
        expect(reply.statusCode, `${method} ${action}`).toBe(404);
      }
    }
    expect((await call('HEAD', '/portal-approval/batch', { cookie: link.cookie, address: link.address })).statusCode).toBe(404);
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('needs the origin of the app for a decision: a POST without it is refused and approves nothing', async () => {
    const link = await withSession({ count: 1 });
    const reply = await w.getApp().app.inject({
      method: 'POST',
      url: `/portal-approval/contents/${link.contents[0]}/approve`,
      remoteAddress: link.address,
      headers: { cookie: link.cookie },
      payload: { revision: 1 }
    });
    expect(reply.statusCode).toBe(403);
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
  });
});

// ---- the batch ------------------------------------------------------------------------------------------------------------------

describe('GET /portal-approval/batch', () => {
  it('reads the batch, with the state of each content, and nothing else of the client', async () => {
    const link = await withSession({ count: 2 });
    const other = await w.seedContent(link.clientId, { status: 'awaiting_approval' });
    const reply = await batch(link);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = reply.json<{ personEmail: string; clientName: string; contents: Row[] }>();
    expect(Object.keys(body).sort()).toEqual(['agencyName', 'clientName', 'contents', 'linkExpiresAt', 'personEmail', 'sessionExpiresAt']);
    expect(body.personEmail).toBe(link.email);
    expect(body.clientName).toContain('approval-link');
    expect(body.contents.map((content) => content.id)).toEqual(link.contents);
    expect(body.contents.map((content) => content.id)).not.toContain(other);
    for (const content of body.contents) {
      expect(content).toMatchObject({ status: 'awaiting_approval', canDecide: true, caption: 'Legenda original', revision: 1, platform: 'instagram' });
      expect(Object.keys(content).sort()).toEqual([
        'canDecide', 'caption', 'coverAssetId', 'format', 'id', 'media', 'platform', 'publishAtTime', 'publishOn', 'publishedOn', 'revision', 'status', 'title'
      ]);
    }
    // The agency's identifiers and the internal ones never reach the person.
    const text = reply.body;
    for (const secret of [w.agencyA, link.accessId, link.linkId, people.production.id, people.admin.id]) expect(text).not.toContain(secret);
  });

  it('shows a decided content without buttons, and one in production as title, day and format', async () => {
    const link = await withSession({ count: 1 });
    const approved = await w.seedContent(link.clientId, { status: 'approved' });
    const production = await w.seedContent(link.clientId, { status: 'in_production', caption: 'Rascunho que o cliente não vê' });
    const cancelled = await w.seedContent(link.clientId, { status: 'cancelled' });
    for (const id of [approved, production, cancelled]) {
      await owner()('client_portal_approval_link_contents').insert({ link_id: link.linkId, content_id: id, client_id: link.clientId });
    }
    const body = (await batch(link)).json<{ contents: Row[] }>();
    const byId = new Map(body.contents.map((content) => [content.id as string, content]));

    expect(byId.has(cancelled)).toBe(false);
    expect(byId.get(approved)).toMatchObject({ status: 'approved', canDecide: false });
    expect(byId.get(production)).toEqual({ id: production, title: expect.any(String), format: 'reels', publishOn: '2026-10-20', status: 'in_production', canDecide: false });
    expect(byId.get(link.contents[0]!)).toMatchObject({ status: 'awaiting_approval', canDecide: true });
  });

  it('does not answer without the cookie, with a malformed one, with an unknown one, or with the cookie of an account', async () => {
    const link = await withSession({ count: 1 });
    const unknown = `${APPROVAL_COOKIE_NAME}=${newToken().token}`;
    for (const cookie of [undefined, `${APPROVAL_COOKIE_NAME}=curto`, unknown, p.people.portalOne.cookie, `${APPROVAL_COOKIE_NAME}=`]) {
      const reply = await call('GET', '/portal-approval/batch', { ...(cookie === undefined ? {} : { cookie }), address: link.address });
      expect(reply.statusCode, String(cookie)).toBe(404);
      expect(errorOf(reply).code).toBe('APPROVAL_LINK_INVALID');
      expect(reply.headers['cache-control']).toBe('no-store');
    }
  });

  it('refuses any query, the token in it included', async () => {
    const link = await withSession({ count: 1 });
    const reply = await call('GET', `/portal-approval/batch?token=${link.token}`, { cookie: link.cookie, address: link.address });
    expect(reply.statusCode).toBe(400);
    expect(reply.body).not.toContain(link.token);
  });

  it('is not an account session: the cookie opens no route of the portal or of the agency', async () => {
    const link = await withSession({ count: 1 });
    for (const url of [
      `/clients/${link.clientId}/contents`,
      `/clients/${link.clientId}/contents/${link.contents[0]}`,
      `/clients/${link.clientId}/threads`,
      '/me/contexts',
      `/agencies/${w.agencyA}/clients/${link.clientId}/contents`
    ]) {
      const reply = await call('GET', url, { cookie: link.cookie, address: link.address });
      expect(reply.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(reply.statusCode, url).toBeLessThan(500);
      expect(reply.body).not.toContain('Legenda original');
    }
  });

  it('keeps the batch of one link out of the reach of the session of another', async () => {
    const mine = await withSession({ count: 1 });
    const theirs = await withSession({ count: 1 });
    const body = (await batch(mine)).json<{ contents: Array<{ id: string }> }>();
    expect(body.contents.map((content) => content.id)).toEqual(mine.contents);
    const crossed = await approve(mine, theirs.contents[0]!);
    expect(crossed.statusCode).toBe(404);
    expect(errorOf(crossed).code).toBe('NOT_FOUND');
    expect((await row(theirs.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('says the same on every response: no Referer to follow and nothing cached', async () => {
    const link = await withSession({ count: 1 });
    const replies = [await batch(link), await call('GET', '/portal-approval/batch', { address: link.address }), await approve(link, link.contents[0]!)];
    for (const reply of replies) {
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.headers['cache-control']).toBe('no-store');
    }
  });
});

// ---- the decisions, and parity with the portal ----------------------------------------------------------------------------

describe('Aprovar and Pedir ajuste, by POST', () => {
  it('approves as the access, and the agency reads that it came through the link of the e-mail', async () => {
    const link = await withSession({ count: 2 });
    const reply = await approve(link, link.contents[0]!);

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: link.contents[0], status: 'approved', canDecide: false });
    expect(await row(link.contents[0]!)).toMatchObject({ approved_by: null, approved_by_portal_access_id: link.accessId });
    expect((await row(link.contents[1]!)).status).toBe('awaiting_approval');

    const seenByAgency = await w.call('GET', people.admin.cookie, `/agencies/${w.agencyA}/clients/${link.clientId}/contents/${link.contents[0]}`);
    expect(seenByAgency.statusCode).toBe(200);
    // The person has no account entered in this portal: the agency sees the address as it was recorded, never an account's name.
    expect(seenByAgency.json().approvedBy).toEqual({ name: link.email, side: 'client', viaLink: true });
  });

  it('asks for the changes as the access: the conversation, the comment and the state, and the agency reads them', async () => {
    const link = await withSession({ count: 1 });
    const reply = await requestChanges(link, link.contents[0]!, 'Troque a foto da capa.');

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ id: link.contents[0], status: 'adjusting', canDecide: false });
    const [thread] = await threadsOf(link.contents[0]!);
    expect(thread).toMatchObject({ opened_by: null, opened_by_portal_access_id: link.accessId, opened_side: 'client' });
    const comments = await owner()('client_thread_comments').where({ thread_id: thread!.id });
    expect(comments).toEqual([expect.objectContaining({ author_user_id: null, author_portal_access_id: link.accessId, author_side: 'client', body: 'Troque a foto da capa.' })]);

    const threads = await w.call('GET', people.admin.cookie, `/agencies/${w.agencyA}/clients/${link.clientId}/threads?contentId=${link.contents[0]}`);
    expect(threads.statusCode).toBe(200);
    const listed = threads.json().data.find((item: { id: string }) => item.id === thread!.id);
    expect(listed.openedBy).toEqual({ name: link.email, side: 'client' });
    const read = await w.call('GET', people.admin.cookie, `/agencies/${w.agencyA}/clients/${link.clientId}/threads/${thread!.id}/comments`);
    expect(read.statusCode).toBe(200);
    expect(read.json().data[0]).toMatchObject({ body: 'Troque a foto da capa.', side: 'client', author: { name: link.email } });
  });

  it('approves in the same transaction as it reads back, and again changes nothing', async () => {
    const link = await withSession({ count: 1 });
    expect((await approve(link, link.contents[0]!)).statusCode).toBe(200);
    const first = await row(link.contents[0]!);
    const again = await approve(link, link.contents[0]!, 99);
    expect(again.statusCode).toBe(200);
    expect(await row(link.contents[0]!)).toEqual(first);
  });

  it.each([
    ['a stale revision', 'approve', 409, 'CONTENT_REVISION_CHANGED'],
    ['a stale revision', 'request-changes', 409, 'CONTENT_REVISION_CHANGED']
  ] as const)('refuses %s on %s with the code of the portal', async (_name, action, status, code) => {
    const link = await withSession({ count: 1 });
    const reply = action === 'approve' ? await approve(link, link.contents[0]!, 7) : await requestChanges(link, link.contents[0]!, 'Troque.', 7);
    expect(reply.statusCode).toBe(status);
    expect(errorOf(reply).code).toBe(code);
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(link.contents[0]!)).toEqual([]);
  });

  it('refuses a comment that is blank, invisible or too long (400) and leaves nothing', async () => {
    const link = await withSession({ count: 1 });
    for (const comment of ['', '   ', '​‍', 'ç'.repeat(2501), 'a\u0007b']) {
      const reply = await requestChanges(link, link.contents[0]!, comment);
      expect(reply.statusCode, JSON.stringify(comment.slice(0, 10))).toBe(400);
      expect(errorOf(reply).code).toBe('VALIDATION_ERROR');
    }
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(link.contents[0]!)).toEqual([]);
  });

  it('answers 404 for a content outside the batch, a cancelled one, an absent one and a malformed id', async () => {
    const link = await withSession({ count: 1 });
    const outside = await w.seedContent(link.clientId, { status: 'awaiting_approval' });
    const cancelled = await w.seedContent(link.clientId, { status: 'cancelled' });
    await owner()('client_portal_approval_link_contents').insert({ link_id: link.linkId, content_id: cancelled, client_id: link.clientId });
    for (const id of [outside, cancelled, randomUUID(), 'not-a-uuid']) {
      for (const reply of [await approve(link, id), await requestChanges(link, id, 'Troque.')]) {
        expect(reply.statusCode, id).toBe(404);
        expect(errorOf(reply).code).toBe('NOT_FOUND');
      }
    }
    expect((await row(outside)).status).toBe('awaiting_approval');
  });

  it('refuses a body with an extra field: who approved is never a field', async () => {
    const link = await withSession({ count: 1 });
    for (const payload of [{ revision: 1, approvedBy: people.admin.id }, { revision: 1, accessId: link.accessId }, { revision: '1' }, {}]) {
      const reply = await call('POST', `/portal-approval/contents/${link.contents[0]}/approve`, { cookie: link.cookie, payload, address: link.address });
      expect(reply.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
  });

  // The same state, decided through the portal by a person with an account, and through the link: the status and the code are the same.
  const PARITY: Array<[string, Status, number, string | undefined]> = [
    ['adjusting', 'adjusting', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['published', 'published', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['in production', 'in_production', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['cancelled', 'cancelled', 404, 'NOT_FOUND']
  ];
  it.each(PARITY)('refuses a content that is %s exactly as the portal does', async (_name, status, httpStatus, code) => {
    const link = await withSession({ count: 1 });
    const target = await w.seedContent(link.clientId, { status });
    await owner()('client_portal_approval_link_contents').insert({ link_id: link.linkId, content_id: target, client_id: link.clientId });
    await owner()('client_memberships').insert({ client_id: link.clientId, user_id: p.people.portalOne.id });
    const portal = (path: string, payload: unknown) => w.call('POST', p.people.portalOne.cookie, `/clients/${link.clientId}/contents/${target}/${path}`, payload);
    try {
      const before = await row(target);
      const byPortalApprove = await portal('approve', { revision: 1 });
      const byLinkApprove = await approve(link, target);
      const byPortalRequest = await portal('request-changes', { revision: 1, comment: 'Troque.' });
      const byLinkRequest = await requestChanges(link, target, 'Troque.');
      for (const reply of [byPortalApprove, byLinkApprove, byPortalRequest, byLinkRequest]) {
        expect(reply.statusCode).toBe(httpStatus);
        expect(errorOf(reply).code).toBe(code);
      }
      expect(await row(target)).toEqual(before);
      expect(await threadsOf(target)).toEqual([]);
    } finally {
      await owner()('client_memberships').where({ client_id: link.clientId, user_id: p.people.portalOne.id }).update({ status: 'removed' }).catch(() => undefined);
    }
  });

  it('has the same effect as the portal on the content: the same final state, who approved aside', async () => {
    const link = await withSession({ count: 1 });
    const twin = await w.seedContent(link.clientId, { status: 'awaiting_approval', publishOn: '2026-10-20' });
    await owner()('client_memberships').insert({ client_id: link.clientId, user_id: p.people.portalMulti.id });
    const byPortal = await w.call('POST', p.people.portalMulti.cookie, `/clients/${link.clientId}/contents/${twin}/approve`, { revision: 1 });
    expect(byPortal.statusCode).toBe(200);
    expect((await approve(link, link.contents[0]!)).statusCode).toBe(200);
    const strip = (value: Row): Row => without(value, 'id', 'title', 'approved_by', 'approved_by_portal_access_id', 'approved_at', 'created_at', 'updated_at');
    expect(strip(await row(link.contents[0]!))).toEqual(strip(await row(twin)));
    expect(await row(twin)).toMatchObject({ approved_by: p.people.portalMulti.id, approved_by_portal_access_id: null });
  });
});

// ---- the revocation, over HTTP -----------------------------------------------------------------------------------------------

describe('the link stops working when its access, client or agency stops allowing it', () => {
  const dead = (reply: { statusCode: number; json<T>(): T }): void => {
    expect(reply.statusCode).toBe(404);
    expect((reply.json<{ error: { code: string } }>()).error.code).toBe('APPROVAL_LINK_INVALID');
  };

  it('is dead after the access is removed: the session, the token and a decision, and nothing is approved', async () => {
    const link = await withSession({ count: 1 });
    await owner()('client_portal_accesses').where({ id: link.accessId }).update({ status: 'removed', generation: 2 });
    dead(await batch(link));
    dead(await approve(link, link.contents[0]!));
    dead(await requestChanges(link, link.contents[0]!, 'Troque.'));
    dead(await call('POST', '/portal-approval/session', { payload: { token: link.token }, address: freshAddress() }));
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
  });

  it('does not come back when the access is added again', async () => {
    const link = await withSession({ count: 1 });
    await owner()('client_portal_accesses').where({ id: link.accessId }).update({ status: 'removed', generation: 2 });
    await owner()('client_portal_accesses').where({ id: link.accessId }).update({ status: 'active' });
    dead(await batch(link));
    dead(await approve(link, link.contents[0]!));
  });

  it('is dead for an archived client', async () => {
    const link = await withSession({ count: 1 });
    await w.getOwner().knex('clients').where({ id: link.clientId }).update({ status: 'archived', archived_at: new Date() });
    dead(await batch(link));
    dead(await approve(link, link.contents[0]!));
  });

  it('is dead for a suspended agency and for a read-only one, and approves nothing', async () => {
    const link = await withSession({ count: 1 });
    try {
      await owner()('agencies').where({ id: w.agencyA }).update({ status: 'suspended' });
      dead(await batch(link));
      dead(await approve(link, link.contents[0]!));
      await owner()('agencies').where({ id: w.agencyA }).update({ status: 'active' });
      await owner()('agencies').where({ id: w.agencyA }).update({
        plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
      });
      dead(await batch(link));
      dead(await approve(link, link.contents[0]!));
      dead(await requestChanges(link, link.contents[0]!, 'Troque.'));
    } finally {
      await owner()('agencies').where({ id: w.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null, status: 'active' });
    }
    expect((await row(link.contents[0]!)).status).toBe('awaiting_approval');
    expect(await threadsOf(link.contents[0]!)).toEqual([]);
  });

  it('is dead after seven days and after the session ended', async () => {
    const aged = await withSession({ count: 1 });
    await owner()('client_portal_approval_links').where({ id: aged.linkId }).update({
      created_at: owner().raw("now() - interval '8 days'"), expires_at: owner().raw("now() - interval '1 day'")
    });
    dead(await batch(aged));
    dead(await call('POST', '/portal-approval/session', { payload: { token: aged.token }, address: freshAddress() }));

    const ended = await withSession({ count: 1 });
    await owner()('client_portal_approval_sessions').where({ link_id: ended.linkId }).update({
      created_at: owner().raw("now() - interval '3 hours'"), expires_at: owner().raw("now() - interval '1 hour'")
    });
    dead(await batch(ended));
    // The link itself is alive: the token opens a new session.
    expect((await exchange(ended)).statusCode).toBe(200);
    expect((await batch(ended)).statusCode).toBe(200);
  });
});

// ---- the media of the preview ----------------------------------------------------------------------------------------------------

describe('GET /portal-approval/contents/:contentId/media/:assetId/url', () => {
  const mediaUrl = (link: Link, contentId: string, assetId: string, query = '') =>
    call('GET', `/portal-approval/contents/${contentId}/media/${assetId}/url${query}`, { cookie: link.cookie, address: link.address });

  it('signs a file of the batch for minutes and never for the days of the link, whatever the deployment allows', async () => {
    const link = await withSession({ count: 1 });
    const folder = await w.folderOf(link.clientId);
    const image = await w.seedAsset(link.clientId, folder);
    await w.attach(link.contents[0]!, [image]);
    signing.expiresInSeconds.length = 0;
    const reply = await mediaUrl(link, link.contents[0]!, image);

    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = reply.json<{ url: string; expiresAt: string }>();
    expect(body.url).toMatch(/^https?:\/\//);
    expect(signing.expiresInSeconds).toHaveLength(1);
    expect(signing.expiresInSeconds[0]).toBeGreaterThan(0);
    expect(signing.expiresInSeconds[0]).toBeLessThanOrEqual(300);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(new URL(body.url).searchParams.get('X-Amz-Expires')).toBe(String(signing.expiresInSeconds[0]));
  });

  it('signs the original of an image for the thumbnail too, and says a video that is not ready is not ready', async () => {
    const link = await withSession({ count: 1 });
    const folder = await w.folderOf(link.clientId);
    const image = await w.seedAsset(link.clientId, folder);
    const video = await w.seedAsset(link.clientId, folder, { category: 'video', video: 'pending' });
    const failed = await w.seedAsset(link.clientId, folder, { category: 'video', video: 'failed' });
    await w.attach(link.contents[0]!, [image, video, failed]);
    expect((await mediaUrl(link, link.contents[0]!, image, '?variant=thumbnail')).statusCode).toBe(200);
    const notReady = await mediaUrl(link, link.contents[0]!, video, '?variant=thumbnail');
    expect(notReady.statusCode).toBe(409);
    expect(errorOf(notReady).code).toBe('VARIANT_NOT_READY');
    const processingFailed = await mediaUrl(link, link.contents[0]!, failed, '?variant=thumbnail');
    expect(processingFailed.statusCode).toBe(409);
    expect(errorOf(processingFailed).code).toBe('VARIANT_PROCESSING_FAILED');
  });

  it('answers 404 and signs nothing for a file of a content outside the batch, of one in production, a removed file and a file of another content', async () => {
    const link = await withSession({ count: 1 });
    const folder = await w.folderOf(link.clientId);
    const own = await w.seedAsset(link.clientId, folder);
    const removed = await w.seedAsset(link.clientId, folder, { removed: true });
    await w.attach(link.contents[0]!, [own, removed]);
    const outside = await w.seedContent(link.clientId, { status: 'awaiting_approval' });
    const outsideAsset = await w.seedAsset(link.clientId, folder);
    await w.attach(outside, [outsideAsset]);
    const production = await w.seedContent(link.clientId, { status: 'in_production' });
    const productionAsset = await w.seedAsset(link.clientId, folder);
    await w.attach(production, [productionAsset]);
    await owner()('client_portal_approval_link_contents').insert({ link_id: link.linkId, content_id: production, client_id: link.clientId });
    const otherClientAsset = await w.seedAsset(p.clientA1, await w.folderOf(p.clientA1));

    signing.expiresInSeconds.length = 0;
    for (const [content, asset] of [
      [outside, outsideAsset], [production, productionAsset], [link.contents[0]!, removed], [link.contents[0]!, outsideAsset], [link.contents[0]!, otherClientAsset], [link.contents[0]!, randomUUID()]
    ] as const) {
      const reply = await mediaUrl(link, content, asset);
      expect(reply.statusCode, `${content}/${asset}`).toBe(404);
    }
    expect(signing.expiresInSeconds).toEqual([]);
    expect((await mediaUrl(link, link.contents[0]!, own)).statusCode).toBe(200);
  });

  it('is dead with the link, does not answer a HEAD and takes no query but the variant', async () => {
    const link = await withSession({ count: 1 });
    const folder = await w.folderOf(link.clientId);
    const image = await w.seedAsset(link.clientId, folder);
    await w.attach(link.contents[0]!, [image]);
    signing.expiresInSeconds.length = 0;
    expect((await call('HEAD', `/portal-approval/contents/${link.contents[0]}/media/${image}/url`, { cookie: link.cookie, address: link.address })).statusCode).toBe(404);
    expect((await mediaUrl(link, link.contents[0]!, image, `?token=${link.token}`)).statusCode).toBe(400);
    expect(signing.expiresInSeconds).toEqual([]);
    await owner()('client_portal_accesses').where({ id: link.accessId }).update({ status: 'removed', generation: 2 });
    const reply = await mediaUrl(link, link.contents[0]!, image);
    expect(reply.statusCode).toBe(404);
    expect(errorOf(reply).code).toBe('APPROVAL_LINK_INVALID');
    expect(signing.expiresInSeconds).toEqual([]);
  });
});

// ---- the limits --------------------------------------------------------------------------------------------------------------------

describe('the limits, by IP and by token', () => {
  it('stops one token after ten tries in fifteen minutes, from any address, and counts the ones that failed', async () => {
    const token = newToken().token;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await call('POST', '/portal-approval/session', { payload: { token }, address: freshAddress() })).statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses[10]).toBe(429);
  });

  it('stops one address after thirty tries in fifteen minutes, whatever the tokens are', async () => {
    const address = freshAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push((await call('POST', '/portal-approval/session', { payload: { token: newToken().token }, address })).statusCode);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(404));
    expect(statuses[30]).toBe(429);
    // Another address is not counted with it.
    expect((await call('POST', '/portal-approval/session', { payload: { token: newToken().token }, address: freshAddress() })).statusCode).toBe(404);
  });

  it('answers the limit with the envelope of the API and nothing of the token', async () => {
    const token = newToken().token;
    let limited: Awaited<ReturnType<typeof call>> | undefined;
    for (let attempt = 0; attempt < 11 && limited === undefined; attempt += 1) {
      const reply = await call('POST', '/portal-approval/session', { payload: { token }, address: freshAddress() });
      if (reply.statusCode === 429) limited = reply;
    }
    expect(limited?.statusCode).toBe(429);
    expect(errorOf(limited!).code).toBe('RATE_LIMITED');
    expect(limited!.body).not.toContain(token);
    expect(limited!.headers['cache-control']).toBe('no-store');
  });

  it('stops the decisions of one session after thirty in fifteen minutes, and of one address after sixty', async () => {
    const link = await withSession({ count: 1 });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      // A decision that is refused still counts: the content is not awaiting a revision 9.
      statuses.push((await call('POST', `/portal-approval/contents/${link.contents[0]}/approve`, { cookie: link.cookie, payload: { revision: 9 }, address: freshAddress() })).statusCode);
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(409));
    expect(statuses[30]).toBe(429);

    const address = freshAddress();
    const another = await withSession({ count: 1 });
    const byAddress: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const fresh = `${APPROVAL_COOKIE_NAME}=${newToken().token}`;
      byAddress.push((await call('POST', `/portal-approval/contents/${another.contents[0]}/approve`, { cookie: fresh, payload: { revision: 1 }, address })).statusCode);
    }
    expect(byAddress.slice(0, 60)).toEqual(Array(60).fill(404));
    expect(byAddress[60]).toBe(429);
  });

  it('counts the reads by session and by address too', async () => {
    const link = await withSession({ count: 1 });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 121; attempt += 1) {
      statuses.push((await call('GET', '/portal-approval/batch', { cookie: link.cookie, address: freshAddress() })).statusCode);
    }
    expect(statuses.slice(0, 120)).toEqual(Array(120).fill(200));
    expect(statuses[120]).toBe(429);

    const address = freshAddress();
    const byAddress: number[] = [];
    for (let attempt = 0; attempt < 301; attempt += 1) {
      byAddress.push((await call('GET', '/portal-approval/batch', { cookie: `${APPROVAL_COOKIE_NAME}=${newToken().token}`, address })).statusCode);
    }
    expect(byAddress.slice(0, 300)).toEqual(Array(300).fill(404));
    expect(byAddress[300]).toBe(429);
  });
});

// ---- the token is nowhere ------------------------------------------------------------------------------------------------------------

describe('the token and the session are in no log, no URL of the server and no Referer', () => {
  it('writes the token, the session and their hashes to no log line, whether the call worked, failed or was refused', async () => {
    const link = await newLink({ count: 1 });
    const exchanged = await exchange(link);
    expect(exchanged.statusCode).toBe(200);
    const session = link.cookie.split('=')[1]!;
    await batch(link);
    await approve(link, link.contents[0]!, 9);
    await call('POST', '/portal-approval/session', { payload: { token: newToken().token }, address: freshAddress() });
    await call('POST', `/portal-approval/session?token=${link.token}`, { payload: { token: link.token }, address: freshAddress() });
    await call('POST', '/portal-approval/session', { payload: { token: 'curto' }, address: freshAddress() });

    const text = logs.text();
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [link.token, session, sha(link.token), sha(session)]) expect(text).not.toContain(secret);
    // The route is logged as a template, with no query: the log of the request has nothing to leak.
    expect(text).not.toMatch(/portal-approval\/session\?/);
  });

  it('puts the token in the body of one POST and in no response header but the session cookie', async () => {
    const link = await newLink({ count: 1 });
    const reply = await exchange(link);
    for (const [name, value] of Object.entries(reply.headers)) {
      expect(String(value), name).not.toContain(link.token);
    }
    const aLink = await newLink({ count: 1 });
    const bad = await call('POST', '/portal-approval/session', { payload: { token: aLink.token, extra: 1 }, address: freshAddress() });
    for (const [name, value] of Object.entries(bad.headers)) expect(String(value), name).not.toContain(aLink.token);
    expect(bad.body).not.toContain(aLink.token);
  });
});
