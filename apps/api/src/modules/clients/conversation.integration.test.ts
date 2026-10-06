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
let operator: TestUserFixture;
let outsider: TestUserFixture;
let otherAdmin: TestUserFixture;
let portalUser: TestUserFixture;

let adminCookie: string;
let operatorCookie: string;
let outsiderCookie: string;
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
    operator = await makeUser('conv-operator');
    outsider = await makeUser('conv-outsider');
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

    // One permission each, so a guard checking the wrong key cannot hide behind a role holding both.
    const operateOnlyRoleId = randomUUID();
    const unrelatedRoleId = randomUUID();
    createdCustomRoleIds.push(operateOnlyRoleId, unrelatedRoleId);
    await owner.knex('roles').insert([
      { id: operateOnlyRoleId, agency_id: agencyA, key: `only-operate-${operateOnlyRoleId}`, name: 'Só operar', is_system: false },
      { id: unrelatedRoleId, agency_id: agencyA, key: `unrelated-${unrelatedRoleId}`, name: 'Sem cliente', is_system: false }
    ]);
    await owner.knex('role_permissions').insert([
      { role_id: operateOnlyRoleId, permission_key: 'cliente.operar' },
      { role_id: unrelatedRoleId, permission_key: 'colaborador.visualizar' }
    ]);

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: operator.id, role_id: operateOnlyRoleId },
      { agency_id: agencyA, user_id: outsider.id, role_id: unrelatedRoleId },
      { agency_id: agencyA, user_id: admin.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: manager.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: production.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: sales.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: finance.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: viewer.id, role_id: customRoleId },
      { agency_id: agencyB, user_id: otherAdmin.id, role_id: roleId('admin') }
    ]);

    adminCookie = await login(admin);
    operatorCookie = await login(operator);
    outsiderCookie = await login(outsider);
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

  it('reads a client-side author through the client tie, and a side that does not match the tie reveals nothing', async () => {
    const clientId = await createClient(agencyA);
    const otherClientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await owner.knex('client_memberships').insert([
      { client_id: clientId, user_id: portalUser.id },
      { client_id: otherClientId, user_id: viewer.id }
    ]);
    await owner.knex('auth.user').where({ id: portalUser.id }).update({ image: `users/${portalUser.id}/avatar/${randomUUID()}.png` });

    await insertComment(threadId, clientId, portalUser.id, 'client', 'do cliente', new Date(Date.now() - 4_000));
    // The portal user has no agency membership: reading them as an agency author would be a loose lookup.
    await insertComment(threadId, clientId, portalUser.id, 'agency', 'lado agência sem vínculo de agência', new Date(Date.now() - 3_000));
    // The manager has no client membership: reading them as a client author would be a loose lookup.
    await insertComment(threadId, clientId, manager.id, 'client', 'lado cliente sem vínculo de cliente', new Date(Date.now() - 2_000));
    // A client tie to a different client of the same agency does not authorize this client's comment.
    await insertComment(threadId, clientId, viewer.id, 'client', 'vínculo de outro cliente', new Date(Date.now() - 1_000));

    const items = (await listComments(managerCookie, agencyA, clientId, threadId)).json<{ data: { body: string; side: string; author: { name: string; photoUrl: string | null } | null }[] }>().data;
    const byBody = (body: string) => items.find((item) => item.body === body);

    expect(byBody('do cliente')).toMatchObject({ side: 'client', author: { name: portalUser.name } });
    expect(typeof byBody('do cliente')?.author?.photoUrl).toBe('string');
    expect(byBody('lado agência sem vínculo de agência')?.author).toBeNull();
    expect(byBody('lado cliente sem vínculo de cliente')?.author).toBeNull();
    expect(byBody('vínculo de outro cliente')?.author).toBeNull();
  });

  it('keeps the line breaks and tabs of a comment, and still refuses the other control characters', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    const multiline = await createComment(managerCookie, agencyA, clientId, threadId, { body: 'primeira linha\n\nsegunda\tlinha\r\nterceira' });
    expect(multiline.statusCode).toBe(201);
    expect(multiline.json()).toMatchObject({ body: 'primeira linha\n\nsegunda\tlinha\r\nterceira' });

    for (const control of ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u001b', '\u007f']) {
      expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: `a${control}b` })).statusCode).toBe(400);
      expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: `a${control}b` })).statusCode).toBe(400);
    }
    await expect(owner.knex('client_thread_comments').where({ thread_id: threadId }).count({ count: '*' })).resolves.toEqual([{ count: '1' }]);
  });

  it('measures the body limit exactly: 5000 bytes pass, 5001 do not, and a non-breaking space is not content', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');

    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'a'.repeat(5_000) })).statusCode).toBe(201);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'a'.repeat(5_001) })).statusCode).toBe(400);
    // The column check is octet_length, so the API refuses what the database would answer with a 500.
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'é'.repeat(2_500) })).statusCode).toBe(201);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 'é'.repeat(2_501) })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: '   \n\t' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'a'.repeat(5_001) })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, { body: 123 })).statusCode).toBe(400);
    expect((await createComment(managerCookie, agencyA, clientId, threadId, {})).statusCode).toBe(400);

    const stored = await createComment(managerCookie, agencyA, clientId, threadId, { body: '   com bordas   ' });
    expect(stored.json()).toMatchObject({ body: 'com bordas' });
  });

  it('accepts each of the seven sections as a subject and refuses any other', async () => {
    const clientId = await createClient(agencyA);
    for (const sectionKey of ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations']) {
      const response = await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey }, body: `sobre ${sectionKey}` });
      expect(response.statusCode).toBe(201);
      expect((await listThreads(managerCookie, agencyA, clientId, `?sectionKey=${sectionKey}`)).json<{ data: unknown[] }>().data).toHaveLength(1);
    }
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'content' }, body: 'x' })).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=content')).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: { personaId: 'not-a-uuid' }, body: 'x' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { body: 'x' })).statusCode).toBe(400);
    expect((await createThread(managerCookie, agencyA, clientId, { subject: null, body: 'x' })).statusCode).toBe(400);
  });

  it('opens a thread on an active persona, and refuses to open one on an archived persona', async () => {
    const clientId = await createClient(agencyA);
    const activePersona = await insertPersona(clientId, 'active');
    const archivedPersona = await insertPersona(clientId, 'archived');

    const opened = await createThread(managerCookie, agencyA, clientId, { subject: { personaId: activePersona }, body: 'sobre a persona' });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ thread: { subject: { personaId: activePersona } } });

    expect((await createThread(managerCookie, agencyA, clientId, { subject: { personaId: archivedPersona }, body: 'x' })).statusCode).toBe(409);
    await expect(owner.knex('client_threads').where({ persona_id: archivedPersona }).select('id')).resolves.toEqual([]);

    // History of an archived persona stays readable to the agency.
    const archivedThread = await insertThread(clientId, { personaId: archivedPersona }, manager.id, 'agency');
    await insertComment(archivedThread, clientId, manager.id, 'agency', 'histórico');
    expect((await listThreads(managerCookie, agencyA, clientId, `?personaId=${archivedPersona}`)).json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await listComments(managerCookie, agencyA, clientId, archivedThread)).json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('answers 404 when the persona of the list is another client\'s, and does not leak that client\'s threads', async () => {
    const clientA1 = await createClient(agencyA);
    const clientA2 = await createClient(agencyA);
    const personaOfA2 = await insertPersona(clientA2);
    await insertThread(clientA2, { personaId: personaOfA2 }, manager.id, 'agency');

    expect((await listThreads(managerCookie, agencyA, clientA1, `?personaId=${personaOfA2}`)).statusCode).toBe(404);
    expect((await listThreads(managerCookie, agencyA, clientA1, `?personaId=${randomUUID()}`)).statusCode).toBe(404);
    expect((await listThreads(managerCookie, agencyA, clientA2, `?personaId=${personaOfA2}`)).json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('answers 404, never 403 or 200, to another agency and to another client of the same agency on all five routes', async () => {
    const clientA1 = await createClient(agencyA);
    const clientA2 = await createClient(agencyA);
    const threadOfA1 = await insertThread(clientA1, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadOfA1, clientA1, manager.id, 'agency', 'privado do cliente 1');

    const attempts = async (cookie: string, agencyId: string, clientId: string): Promise<number[]> => [
      (await listThreads(cookie, agencyId, clientId, '?sectionKey=branding')).statusCode,
      (await createThread(cookie, agencyId, clientId, { subject: { sectionKey: 'branding' }, body: 'x' })).statusCode,
      (await listComments(cookie, agencyId, clientId, threadOfA1)).statusCode,
      (await createComment(cookie, agencyId, clientId, threadOfA1, { body: 'x' })).statusCode,
      (await resolveThread(cookie, agencyId, clientId, threadOfA1)).statusCode
    ];

    // Another agency's admin (every permission there) against agency A's ids, with each client.
    expect(await attempts(otherAdminCookie, agencyA, clientA1)).toEqual([404, 404, 404, 404, 404]);
    expect(await attempts(otherAdminCookie, agencyA, clientA2)).toEqual([404, 404, 404, 404, 404]);
    // Agency A's manager naming agency B in the URL.
    expect(await attempts(managerCookie, agencyB, clientA1)).toEqual([404, 404, 404, 404, 404]);
    // The right agency, the wrong client: the thread belongs to client 1.
    expect(await attempts(managerCookie, agencyA, clientA2)).toEqual([200, 201, 404, 404, 404]);

    await expect(owner.knex('client_thread_comments').where({ thread_id: threadOfA1 }).count({ count: '*' })).resolves.toEqual([{ count: '1' }]);
    await expect(owner.knex('client_threads').where({ id: threadOfA1 }).first('resolved_at')).resolves.toEqual({ resolved_at: null });
    await expect(owner.knex('client_threads').where({ client_id: clientA1 }).count({ count: '*' })).resolves.toEqual([{ count: '1' }]);
  });

  it('guards every route with its own permission: a role with only cliente.operar cannot read, one with only cliente.visualizar cannot write, one with neither cannot do anything', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'existente');

    const reads = async (cookie: string): Promise<number[]> => [
      (await listThreads(cookie, agencyA, clientId, '?sectionKey=branding')).statusCode,
      (await listComments(cookie, agencyA, clientId, threadId)).statusCode
    ];
    const writes = async (cookie: string): Promise<number[]> => [
      (await createThread(cookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'x' })).statusCode,
      (await createComment(cookie, agencyA, clientId, threadId, { body: 'x' })).statusCode,
      (await resolveThread(cookie, agencyA, clientId, threadId)).statusCode
    ];

    expect(await reads(operatorCookie)).toEqual([403, 403]);
    expect(await reads(outsiderCookie)).toEqual([403, 403]);
    expect(await reads(viewerCookie)).toEqual([200, 200]);
    expect(await writes(outsiderCookie)).toEqual([403, 403, 403]);
    expect(await writes(viewerCookie)).toEqual([403, 403, 403]);
    expect(await writes(operatorCookie)).toEqual([201, 201, 200]);
  });

  it('requires a session on every route, and the origin check on every write', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const base = `/agencies/${agencyA}/clients/${clientId}/threads`;

    const anonymous = [
      await app.app.inject({ method: 'GET', url: `${base}?sectionKey=branding` }),
      await app.app.inject({ method: 'GET', url: `${base}/${threadId}/comments` }),
      await app.app.inject({ method: 'POST', url: base, headers: origin, payload: { subject: { sectionKey: 'branding' }, body: 'x' } }),
      await app.app.inject({ method: 'POST', url: `${base}/${threadId}/comments`, headers: origin, payload: { body: 'x' } }),
      await app.app.inject({ method: 'POST', url: `${base}/${threadId}/resolve`, headers: origin })
    ];
    expect(anonymous.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401]);

    const noOrigin = [
      await app.app.inject({ method: 'POST', url: base, headers: { cookie: managerCookie }, payload: { subject: { sectionKey: 'branding' }, body: 'x' } }),
      await app.app.inject({ method: 'POST', url: `${base}/${threadId}/comments`, headers: { cookie: managerCookie }, payload: { body: 'x' } }),
      await app.app.inject({ method: 'POST', url: `${base}/${threadId}/resolve`, headers: { cookie: managerCookie } })
    ];
    expect(noOrigin.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(noOrigin.map((response) => (response.json() as { error: { code: string } }).error.code)).toEqual(['CSRF_REJECTED', 'CSRF_REJECTED', 'CSRF_REJECTED']);
    await expect(owner.knex('client_threads').where({ client_id: clientId }).count({ count: '*' })).resolves.toEqual([{ count: '1' }]);
  });

  it('answers a hostile body with 400 or 415, never a 500 and without echoing it', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const url = `/agencies/${agencyA}/clients/${clientId}/threads/${threadId}/comments`;
    const send = async (headers: Record<string, string>, payload: string) =>
      app.app.inject({ method: 'POST', url, headers: { ...origin, cookie: managerCookie, ...headers }, payload });

    const malformed = await send({ 'content-type': 'application/json' }, '{"body": "segredo-ecoado');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('segredo-ecoado');
    expect((await send({ 'content-type': 'application/json' }, '')).statusCode).toBe(400);
    expect((await send({ 'content-type': 'application/json' }, 'null')).statusCode).toBe(400);
    expect((await send({ 'content-type': 'application/json' }, '[]')).statusCode).toBe(400);
    expect((await send({ 'content-type': 'application/json' }, `{"body":${'['.repeat(5_000)}${']'.repeat(5_000)}}`)).statusCode).toBe(400);
    const wrongType = await send({ 'content-type': 'text/plain' }, 'body=segredo-ecoado');
    expect([400, 415]).toContain(wrongType.statusCode);
    expect(wrongType.body).not.toContain('segredo-ecoado');
    await expect(owner.knex('client_thread_comments').where({ thread_id: threadId }).select('id')).resolves.toEqual([]);
  });

  it('pages the threads by 20 on the last activity, newest first, and clamps the page size to 100', async () => {
    const clientId = await createClient(agencyA);
    const base = Date.now() - 3_600_000;
    const threadIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
      await insertComment(threadId, clientId, manager.id, 'agency', `thread ${index}`, new Date(base + index * 1_000));
      threadIds.push(threadId);
    }
    // The oldest thread receives the latest comment: it must lead, because the order is by activity.
    await insertComment(threadIds[0] as string, clientId, manager.id, 'agency', 'atividade recente', new Date(base + 60_000));

    const first = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding')).json<{ data: { id: string }[]; meta: { page: number; pageSize: number; totalItems: number; totalPages: number } }>();
    expect(first.meta).toEqual({ page: 1, pageSize: 20, totalItems: 21, totalPages: 2 });
    expect(first.data.map((item) => item.id)).toEqual([threadIds[0], ...threadIds.slice(2).reverse()]);

    const second = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&page=2')).json<{ data: { id: string }[] }>();
    expect(second.data.map((item) => item.id)).toEqual([threadIds[1]]);

    const clamped = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&pageSize=1000')).json<{ meta: { pageSize: number } }>();
    expect(clamped.meta.pageSize).toBe(100);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&pageSize=0')).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=reopened')).statusCode).toBe(400);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&unknown=1')).statusCode).toBe(400);

    const far = await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&page=9007199254740991&pageSize=100');
    expect(far.statusCode).toBe(200);
    expect(far.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('pages the comments by 50, oldest first', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const base = Date.now() - 3_600_000;
    for (let index = 0; index < 51; index += 1) {
      await insertComment(threadId, clientId, manager.id, 'agency', `comentário ${index}`, new Date(base + index * 1_000));
    }

    const first = (await listComments(managerCookie, agencyA, clientId, threadId)).json<{ data: { body: string }[]; meta: { pageSize: number; totalItems: number; totalPages: number } }>();
    expect(first.meta).toMatchObject({ pageSize: 50, totalItems: 51, totalPages: 2 });
    expect(first.data[0]?.body).toBe('comentário 0');
    expect(first.data[49]?.body).toBe('comentário 49');
    const second = (await listComments(managerCookie, agencyA, clientId, threadId, '?page=2')).json<{ data: { body: string }[] }>();
    expect(second.data.map((item) => item.body)).toEqual(['comentário 50']);
    expect((await listComments(managerCookie, agencyA, clientId, threadId, '?pageSize=500')).json<{ meta: { pageSize: number } }>().meta.pageSize).toBe(100);
  });

  it('filters by state, and the list item says what the screen needs and nothing else', async () => {
    const clientId = await createClient(agencyA);
    const openThread = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const longBody = `${'x'.repeat(200)}`;
    await insertComment(openThread, clientId, manager.id, 'agency', longBody, new Date(Date.now() - 20_000));
    await insertComment(openThread, clientId, manager.id, 'agency', 'última', new Date(Date.now() - 10_000));
    const resolvedThread = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency', new Date());
    await insertComment(resolvedThread, clientId, manager.id, 'agency', 'resolvida', new Date(Date.now() - 60_000));

    const open = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=open')).json<{ data: Record<string, unknown>[] }>().data;
    const resolved = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=resolved')).json<{ data: Record<string, unknown>[] }>().data;
    const all = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding')).json<{ data: Record<string, unknown>[] }>().data;
    expect(open.map((item) => item.id)).toEqual([openThread]);
    expect(resolved.map((item) => item.id)).toEqual([resolvedThread]);
    expect(all).toHaveLength(2);

    expect(Object.keys(open[0] as object).sort()).toEqual(['commentCount', 'id', 'lastComment', 'openedBy', 'resolvedAt', 'resolvedBy', 'state', 'subject']);
    expect(open[0]).toMatchObject({
      state: 'open', commentCount: 2, resolvedBy: null, resolvedAt: null,
      openedBy: { name: manager.name, side: 'agency' }, lastComment: { side: 'agency', excerpt: 'última' }
    });
    expect(Object.keys((open[0] as { lastComment: object }).lastComment).sort()).toEqual(['at', 'excerpt', 'side']);

    // The excerpt is a preview, never the whole body.
    await insertComment(openThread, clientId, manager.id, 'agency', longBody, new Date(Date.now() - 5_000));
    const previewed = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=open')).json<{ data: { lastComment: { excerpt: string } }[] }>().data;
    expect(previewed[0]?.lastComment.excerpt).toHaveLength(160);
  });

  it('exposes only the author name and photo on a comment, never an id, an e-mail or a credential', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    const created = await createComment(managerCookie, agencyA, clientId, threadId, { body: 'campos' });
    const listed = (await listComments(managerCookie, agencyA, clientId, threadId)).json<{ data: Record<string, unknown>[] }>().data;

    for (const comment of [created.json<Record<string, unknown>>(), listed[0] as Record<string, unknown>]) {
      expect(Object.keys(comment).sort()).toEqual(['author', 'body', 'createdAt', 'id', 'side']);
      expect(Object.keys(comment.author as object).sort()).toEqual(['name', 'photoUrl']);
    }
    // The photo URL is a signed link whose key carries the owner's id (as everywhere else in the product).
    const withoutPhoto = JSON.stringify(listed.map((comment) => ({ ...comment, author: { name: (comment.author as { name: string }).name } })));
    expect(withoutPhoto).not.toContain(manager.email);
    expect(withoutPhoto).not.toContain(manager.id);
  });

  it('stamps the resolver and the time on the first resolve, and a second resolve by someone else changes nothing', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'a resolver', new Date(Date.now() - 60_000));

    const before = Date.now();
    const first = await resolveThread(managerCookie, agencyA, clientId, threadId);
    expect(first.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: manager.name } });
    const stored = await owner.knex('client_threads').where({ id: threadId }).first('resolved_at', 'resolved_by');
    expect(stored?.resolved_by).toBe(manager.id);
    expect(new Date(stored?.resolved_at as Date).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(new Date(stored?.resolved_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const second = await resolveThread(adminCookie, agencyA, clientId, threadId);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: manager.name } });
    await expect(owner.knex('client_threads').where({ id: threadId }).first('resolved_at', 'resolved_by')).resolves.toEqual(stored);
  });

  it('serializes two resolves racing on the same thread: one resolver wins and both answer the same state', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'corrida', new Date(Date.now() - 60_000));

    const [fromManager, fromAdmin] = await Promise.all([
      resolveThread(managerCookie, agencyA, clientId, threadId),
      resolveThread(adminCookie, agencyA, clientId, threadId)
    ]);
    expect([fromManager.statusCode, fromAdmin.statusCode]).toEqual([200, 200]);
    const a = fromManager.json<{ resolvedBy: { name: string }; resolvedAt: string }>();
    const b = fromAdmin.json<{ resolvedBy: { name: string }; resolvedAt: string }>();
    expect(a.resolvedBy).toEqual(b.resolvedBy);
    expect(a.resolvedAt).toBe(b.resolvedAt);
  });

  it('reopens a resolved thread when the agency comments again, as an answer from the agency', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'início', new Date(Date.now() - 60_000));
    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).json()).toMatchObject({ state: 'resolved' });

    const reopened = await createComment(managerCookie, agencyA, clientId, threadId, { body: 'voltando ao assunto' });
    expect(reopened.statusCode).toBe(201);

    const open = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=open')).json<{ data: { id: string; resolvedBy: unknown }[] }>().data;
    expect(open.map((item) => item.id)).toEqual([threadId]);
    expect((await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=resolved')).json<{ data: unknown[] }>().data).toEqual([]);
    const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: managerCookie } });
    expect(detail.json()).toMatchObject({ summary: { threadsAwaitingAgency: 0, threadsAnsweredByAgency: 1 } });
  });

  it('counts a thread as awaiting the agency again when a client comment lands after the resolution, even one dated before it', async () => {
    const clientId = await createClient(agencyA);
    const threadId = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency');
    await insertComment(threadId, clientId, manager.id, 'agency', 'início', new Date(Date.now() - 60_000));
    await owner.knex('client_memberships').insert({ client_id: clientId, user_id: portalUser.id });
    expect((await resolveThread(managerCookie, agencyA, clientId, threadId)).json()).toMatchObject({ state: 'resolved' });

    // Backdated on purpose: this is what a comment whose transaction began before the resolve looks like.
    await insertComment(threadId, clientId, portalUser.id, 'client', 'pergunta que chegou no meio da resolução', new Date(Date.now() - 30_000));

    const open = (await listThreads(managerCookie, agencyA, clientId, '?sectionKey=branding&state=open')).json<{ data: { id: string; lastComment: { side: string } }[] }>().data;
    expect(open).toEqual([expect.objectContaining({ id: threadId, lastComment: expect.objectContaining({ side: 'client' }) })]);
    const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyA}/clients/${clientId}`, headers: { ...origin, cookie: managerCookie } });
    expect(detail.json()).toMatchObject({ summary: { threadsAwaitingAgency: 1 } });
  });

  it('calls a thread resolved only when the resolution is strictly later than its last comment', async () => {
    const clientId = await createClient(agencyA);
    const instant = new Date(Date.now() - 120_000);
    const sameInstant = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency', instant);
    await insertComment(sameInstant, clientId, manager.id, 'agency', 'no mesmo instante', instant);
    const later = await insertThread(clientId, { sectionKey: 'branding' }, manager.id, 'agency', new Date(instant.getTime() + 1_000));
    await insertComment(later, clientId, manager.id, 'agency', 'antes da resolução', instant);

    const byState = async (state: string): Promise<string[]> =>
      (await listThreads(managerCookie, agencyA, clientId, `?sectionKey=branding&state=${state}`)).json<{ data: { id: string }[] }>().data.map((item) => item.id);
    expect(await byState('open')).toEqual([sameInstant]);
    expect(await byState('resolved')).toEqual([later]);
  });

  it('opens the thread and its first comment in one transaction: a failing comment leaves no thread behind', async () => {
    const clientId = await createClient(agencyA);
    const marker = `fail-${randomUUID()}`;
    await owner.knex.raw(`
      create function public.conversation_test_fail() returns trigger language plpgsql as $$
      begin
        if new.body = '${marker}' then raise exception 'injected failure'; end if;
        return new;
      end;
      $$
    `);
    await owner.knex.raw('create trigger conversation_test_fail before insert on public.client_thread_comments for each row execute function public.conversation_test_fail()');
    try {
      expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: marker })).statusCode).toBe(500);
      await expect(owner.knex('client_threads').where({ client_id: clientId }).select('id')).resolves.toEqual([]);
      expect((await createThread(managerCookie, agencyA, clientId, { subject: { sectionKey: 'branding' }, body: 'ok' })).statusCode).toBe(201);
    } finally {
      await owner.knex.raw('drop trigger conversation_test_fail on public.client_thread_comments');
      await owner.knex.raw('drop function public.conversation_test_fail()');
    }
  });
});
