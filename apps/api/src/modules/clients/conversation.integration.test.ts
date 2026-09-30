import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import type { DatabaseClient } from '@ageniza/database';

const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdAgencyIds = [agencyA, agencyB];
const createdCustomRoleIds: string[] = [];

let admin: TestUserFixture;
let manager: TestUserFixture;
let production: TestUserFixture;
let sales: TestUserFixture;
let finance: TestUserFixture;
let viewer: TestUserFixture;
let otherAdmin: TestUserFixture;
let portalUser: TestUserFixture;

let managerCookie: string;
let productionCookie: string;
let salesCookie: string;
let financeCookie: string;
let viewerCookie: string;
let otherAdminCookie: string;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (label: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: label });
  createdUserIds.push(user.id);
  return user;
};

const createClient = async (agencyId: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `Conv client ${id}`, status, archived_at: status === 'archived' ? new Date() : null });
  return id;
};

const insertPersona = async (clientId: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_personas').insert({ id, client_id: clientId, name: `Persona ${id}`, status });
  return id;
};

const insertThread = async (clientId: string, subject: { sectionKey: string } | { personaId: string }, openedBy: string, openedSide: 'agency' | 'client', resolvedAt: Date | null = null): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_threads').insert({
    id,
    client_id: clientId,
    section_key: 'sectionKey' in subject ? subject.sectionKey : null,
    persona_id: 'personaId' in subject ? subject.personaId : null,
    opened_by: openedBy,
    opened_side: openedSide,
    resolved_at: resolvedAt,
    resolved_by: resolvedAt === null ? null : openedBy
  });
  return id;
};

const insertComment = async (threadId: string, clientId: string, authorUserId: string, side: 'agency' | 'client', body: string, createdAt?: Date): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_thread_comments').insert({
    id, thread_id: threadId, client_id: clientId, author_user_id: authorUserId, author_side: side, body,
    ...(createdAt === undefined ? {} : { created_at: createdAt })
  });
  return id;
};

interface InjectResponse {
  readonly statusCode: number;
  json<T = unknown>(): T;
}

const listThreads = async (cookie: string, agencyId: string, clientId: string, query = ''): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${clientId}/threads${query}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

const createThread = async (cookie: string, agencyId: string, clientId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients/${clientId}/threads`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const listComments = async (cookie: string, agencyId: string, clientId: string, threadId: string, query = ''): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${clientId}/threads/${threadId}/comments${query}`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

const createComment = async (cookie: string, agencyId: string, clientId: string, threadId: string, payload: Record<string, unknown>): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients/${clientId}/threads/${threadId}/comments`, headers: { ...origin, cookie }, payload })) as unknown as InjectResponse;

const resolveThread = async (cookie: string, agencyId: string, clientId: string, threadId: string): Promise<InjectResponse> =>
  (await app.app.inject({ method: 'POST', url: `/agencies/${agencyId}/clients/${clientId}/threads/${threadId}/resolve`, headers: { ...origin, cookie } })) as unknown as InjectResponse;

describe('CLIENTS conversation HTTP module (#128)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    admin = await makeUser('conv-admin');
    manager = await makeUser('conv-manager');
    production = await makeUser('conv-production');
    sales = await makeUser('conv-sales');
    finance = await makeUser('conv-finance');
    viewer = await makeUser('conv-viewer');
    otherAdmin = await makeUser('conv-other-admin');
    portalUser = await makeUser('conv-portal');

    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Conv Agency A', owner_user_id: null },
      { id: agencyB, name: 'Conv Agency B', owner_user_id: null }
    ]);

    const customRoleId = randomUUID();
    createdCustomRoleIds.push(customRoleId);
    await owner.knex('roles').insert({ id: customRoleId, agency_id: agencyA, key: `only-view-${customRoleId}`, name: 'Só visualizar', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: customRoleId, permission_key: 'cliente.visualizar' });

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: admin.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: manager.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: production.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: sales.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: finance.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: viewer.id, role_id: customRoleId },
      { agency_id: agencyB, user_id: otherAdmin.id, role_id: roleId('admin') }
    ]);

    managerCookie = await login(manager);
    productionCookie = await login(production);
    salesCookie = await login(sales);
    financeCookie = await login(finance);
    viewerCookie = await login(viewer);
    otherAdminCookie = await login(otherAdmin);
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdCustomRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdCustomRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('lets account_manager open, comment and resolve; production, sales and finance read but are forbidden on writes', async () => {
    const clientId = await createClient(agencyA);

    const opened = await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'Sugestão inicial.' });
    expect(opened.statusCode).toBe(201);
    const created = opened.json<{ thread: { id: string; subject: unknown; state: string; commentCount: number; openedBy: { side: string } }; comment: { side: string; body: string; author: { name: string } } }>();
    expect(created.thread).toMatchObject({ subject: { sectionKey: 'branding' }, state: 'open', commentCount: 1, openedBy: { side: 'agency' } });
    expect(created.comment).toMatchObject({ side: 'agency', body: 'Sugestão inicial.', author: { name: manager.name } });
    const threadId = created.thread.id;

    const commented = await createComment(managerCookie, agencyA, clientId, threadId, { body: 'Acompanhando.' });
    expect(commented.statusCode).toBe(201);
    expect(commented.json()).toMatchObject({ side: 'agency', body: 'Acompanhando.' });

    const resolved = await resolveThread(managerCookie, agencyA, clientId, threadId);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: manager.name } });
    expect((resolved.json() as { resolvedAt: string | null }).resolvedAt).not.toBeNull();

    for (const cookie of [productionCookie, salesCookie, financeCookie]) {
      expect((await listThreads(cookie, agencyA, clientId, '?sectionKey=branding')).statusCode).toBe(200);
      expect((await listComments(cookie, agencyA, clientId, threadId)).statusCode).toBe(200);
      expect((await createThread(cookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x' })).statusCode).toBe(403);
      expect((await createComment(cookie, agencyA, clientId, threadId, { body: 'x' })).statusCode).toBe(403);
      expect((await resolveThread(cookie, agencyA, clientId, threadId)).statusCode).toBe(403);
    }
  });

  it('never takes the side from the body: a side field is rejected and the stored side is agency', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'x', side: 'client' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x', side: 'client' })).statusCode).toBe(400);

    const ok = await createComment(managerCookie, agencyA, clientId, threadId, { body: 'comentário da agência' });
    expect(ok.json()).toMatchObject({ side: 'agency' });
    await expect(owner.knex('client_thread_comments').where({ id: ok.json<{ id: string }>().id }).first('author_side')).resolves.toEqual({ author_side: 'agency' });
  });

  it('requires exactly one subject, both on the body and on the query', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersona(clientId);

    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding', personaId }, body: 'x' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'not_a_section' }, body: 'x' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: {}, body: 'x' })).statusCode).toBe(400);

    expect((await listThreads(managerCookie, agencyA, clientId, '')).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, `?sectionKey=branding&personaId=${personaId}`)).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding')).statusCode).toBe(200);
    expect((await listThreads(managerCookie, agencyA, clientId, `?personaId=${personaId}`)).statusCode).toBe(200);
  });

  it('answers 404 for a persona of another client as the subject', async () => {
    const clientA1 = await createClient(agencyA);
    const clientA2 = await createClient(agencyA);
    const personaOfA2 = await insertPersona(clientA2);

    const response = await createThread(managerCookie, agencyA, clientA1, { subject: { personaId: personaOfA2 }, body: 'x' });
    expect(response.statusCode).toBe(404);
    await expect(owner.knex('client_threads').where({ client_id: clientA1 }).select('id')).resolves.toEqual([]);
  });

  it('refuses a comment and a resolve on a thread whose persona is archived', async () => {
    const clientId = await createClient(agencyA);
    const personaId = await insertPersona(clientId, 'active');
    const threadId = await insertThread(clientId, { personaId }, manager.id, 'agency');

    await owner.knex('client_personas').where({ id: personaId }).update({ status: 'archived' });

    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'x' })).statusCode).toBe(409);
    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).statusCode).toBe(409);
    await expect(owner.knex('client_thread_comments').where({ thread_id: threadId }).select('id')).resolves.toEqual([]);
  });

  it('reopens a resolved thread when a client comments, counting it as awaiting the agency', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'Resposta da agência');

    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).json()).toMatchObject({ state: 'resolved' });
    // Idempotent: resolving again keeps it resolved.
    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).json()).toMatchObject({ state: 'resolved' });

    // A client comment dated after the resolution reopens the thread; no write touches the thread.
    await owner.knex('client_memberships').insert({ client_id: clientId, user_id: portalUser.id });
    await insertComment(threadId, clientId, portalUser.id, 'client', 'Nova dúvida', new Date(Date.now() + 60_000));

    const openList = await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=open');
    expect(openList.json<{ data: { id: string; state: string; lastComment: { side: string } }[] }>().data).toContainEqual(
      expect.objectContaining({ id: threadId, state: 'open', lastComment: expect.objectContaining({ side: 'client' }) })
    );
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=resolved')).json<{ data: unknown[] }>().data).toEqual([]);

    const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: managerCookie } });
    expect(detail.json()).toMatchObject({ summary: { threadsAwaitingAgency: 1 } });
  });

  it('has no route to edit or delete a comment', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const commentId = await insertComment(threadId, clientId, manager.id, 'agency', 'Imutável');

    const base = `/agencies/${agencyA}/clients/${clientId}/threads/${threadId}/comments`;
    expect((await app.app.inject({ method: 'PATCH', url: `${base}/${commentId}`, headers: { ...origin, cookie: managerCookie }, payload: { body: 'editado' } })).statusCode).toBe(404);
    expect((await app.app.inject({ method: 'DELETE', url: `${base}/${commentId}`, headers: { ...origin, cookie: managerCookie } })).statusCode).toBe(404);
    await expect(owner.knex('client_thread_comments').where({ id: commentId }).first('body')).resolves.toEqual({ body: 'Imutável' });
  });

  it('answers 409 on every write to an archived client, and still reads it', async () => {
    const clientId = await createClient(agencyA, 'archived');
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding')).statusCode).toBe(200);
    expect((await listComments(managerCookie, agencyA, clientId, threadId)).statusCode).toBe(200);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x' })).statusCode).toBe(409);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'x' })).statusCode).toBe(409);
    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).statusCode).toBe(409);
  });

  it('rejects an empty, whitespace-only or oversized comment body', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: '' })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: '   ' })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'a'.repeat(5_001) })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'Nul\u0000byte' })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'ok' })).statusCode).toBe(201);
  });

  it('hides a thread of another client or agency and answers 404 for malformed ids', async () => {
    const clientA1 = await createClient(agencyA);
    const clientA2 = await createClient(agencyA);
    const clientB = await createClient(agencyB);
    const threadOfA2 = await insertThread(clientA2, { sectionKey: 'branding' }, manager.id, 'agency');
    const threadOfB = await insertThread(clientB, { sectionKey: 'branding' }, otherAdmin.id, 'agency');

    expect((await listComments(managerCookie, agencyA, clientA1, threadOfA2)).statusCode).toBe(404);
    expect((await createComment(managerCookie, agencyA, clientA1, threadOfA2, { body: 'x' })).statusCode).toBe(404);
    expect((await resolveThread(managerCookie, agencyA, clientA1, threadOfB)).statusCode).toBe(404);
    expect((await listThreads(managerCookie, agencyA, clientB, '?sectionKey=branding')).statusCode).toBe(404);
    expect((await listComments(managerCookie, agencyA, clientA1, 'not-a-uuid')).statusCode).toBe(404);
    expect((await listThreads(managerCookie, agencyA, 'not-a-uuid', '?sectionKey=branding')).statusCode).toBe(404);
    expect((await listThreads(otherAdminCookie, agencyA, clientA1, '?sectionKey=branding')).statusCode).toBe(404);
  });

  it('rejects extra fields (BOPLA) and an overflow page', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x', openedSide: 'client' })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'x', author: 'x' })).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&page=4e17')).statusCode).toBe(400);
    expect((await listComments(managerCookie, agencyA, clientId, threadId, '?page=4e17')).statusCode).toBe(400);
  });

  it('enforces BFLA with a one-permission custom role: reads, cannot write', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await listThreads(viewerCookie, agencyA, clientId, '?sectionKey=branding')).statusCode).toBe(200);
    expect((await listComments(viewerCookie, agencyA, clientId, threadId)).statusCode).toBe(200);
    expect((await createThread(viewerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x' })).statusCode).toBe(403);
    expect((await createComment(viewerCookie, agencyA, clientId, threadId, { body: 'x' })).statusCode).toBe(403);
    expect((await resolveThread(viewerCookie, agencyA, clientId, threadId)).statusCode).toBe(403);
  });

  it('reads the author through the comment tie, never auth.user by a loose id, and signs the photo', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    const photoKey = `users/${manager.id}/avatar/${randomUUID()}.png`;
    await owner.knex('auth.user').where({ id: manager.id }).update({ image: photoKey });
    await createComment(managerCookie, agencyA, clientId, threadId, { body: 'com foto' });

    // An author with no tie to this client/agency must not have their name or photo revealed.
    await insertComment(threadId, clientId, otherAdmin.id, 'agency', 'autor sem vínculo');

    const comments = await listComments(managerCookie, agencyA, clientId, threadId);
    const items = comments.json<{ data: { body: string; author: { name: string; photoUrl: string | null } | null }[] }>().data;
    const own = items.find((item) => item.body === 'com foto');
    expect(own?.author?.name).toBe(manager.name);
    expect(typeof own?.author?.photoUrl).toBe('string');
    const untied = items.find((item) => item.body === 'autor sem vínculo');
    expect(untied?.author).toBeNull();
  });
});
