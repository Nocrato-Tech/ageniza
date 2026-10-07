import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
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
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';

// Issues #128 (agency side) and #130 (portal side): the conversation between an agency and its
// client, over one shared service. Every scenario that proves isolation uses a person who belongs
// to more than one tenant, so that a missing filter shows up as a leaked row instead of being hidden
// by row-level security.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdCustomRoleIds: string[] = [];

const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const clientBare = randomUUID();
const clientArchived = randomUUID();
const personaActive = randomUUID();
const personaArchived = randomUUID();
const personaOfA2 = randomUUID();

const OWNER_NAME = 'Dona da Agência';
const MANAGER_NAME = 'Marta Gestora';
const ADMIN_NAME = 'Adriana Admin';
const PORTAL_ONE_NAME = 'Ana do Portal';
const PORTAL_TWO_NAME = 'Bruno do Portal';

const sessionCookieHeader = (cookiesList: readonly { name: string; value: string }[]): string =>
  cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `conv-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({ method, url, headers: { ...origin, cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })) as unknown as Reply;

const agencyThreads = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/threads`;
const portalThreads = (clientId: string): string => `/clients/${clientId}/threads`;

const section = (sectionKey: string): string => `sectionKey=${sectionKey}`;

const openAs = (cookie: string, url: string, subject: Record<string, unknown>, body = 'Primeiro comentário'): Promise<Reply> =>
  call('POST', url, cookie, { subject, body });

interface SeedComment {
  readonly author: string;
  readonly side: 'agency' | 'client';
  readonly body?: string;
  readonly at: string;
}

/** Writes a thread and its comments as the schema owner, with chosen dates: the fixture for ordering and paging. */
const seedThread = async (clientId: string, subject: { sectionKey: string } | { personaId: string }, comments: readonly SeedComment[], resolvedAt?: string): Promise<string> => {
  const id = randomUUID();
  const first = comments[0];
  if (first === undefined) throw new Error('A thread needs a first comment.');
  await owner.knex('client_threads').insert({
    id,
    client_id: clientId,
    section_key: 'sectionKey' in subject ? subject.sectionKey : null,
    persona_id: 'personaId' in subject ? subject.personaId : null,
    opened_by: users[first.author]!.id,
    opened_side: first.side,
    created_at: first.at
  });
  await owner.knex('client_thread_comments').insert(comments.map((comment) => ({
    thread_id: id,
    client_id: clientId,
    author_user_id: users[comment.author]!.id,
    author_side: comment.side,
    body: comment.body ?? `comment by ${comment.author}`,
    created_at: comment.at
  })));
  if (resolvedAt !== undefined) {
    await owner.knex('client_threads').where({ id }).update({ resolved_at: resolvedAt, resolved_by: users.admin!.id });
  }
  return id;
};

const threadRow = (threadId: string): Promise<Record<string, unknown> | undefined> =>
  owner.knex('client_threads').where({ id: threadId }).first();

const commentRows = (threadId: string): Promise<Record<string, unknown>[]> =>
  owner.knex('client_thread_comments').where({ thread_id: threadId }).orderBy('created_at', 'asc');

const countThreads = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_threads').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const countComments = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_thread_comments').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const iso = (value: unknown): string => new Date(value as string).toISOString();

/**
 * An app whose database turns one kind of write into the failure real life produces when the client
 * or the persona changes between the route's checks and its write: the statement is refused by
 * row-level security (`rls`) or matches no row (`empty`). `beforeFailure` is where the test makes the
 * world change, so the route's own diagnosis in a fresh transaction sees it.
 */
const withRacingApp = async <T>(
  race: { readonly statement: string; readonly failure: 'rls' | 'empty'; readonly beforeFailure?: () => Promise<void> },
  run: (racingApp: FastifyInstance) => Promise<T>
): Promise<T> => {
  const racingApp = Fastify();
  registerClientModule(racingApp, {
    database: {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const racing = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return async (statement: string, bindings?: readonly unknown[]) => {
                  if (!statement.trim().startsWith(race.statement)) return target.raw(statement, bindings as never);
                  await race.beforeFailure?.();
                  if (race.failure === 'empty') return { rows: [] };
                  throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
                };
              }
              return Reflect.get(target, property, receiver);
            }
          });
          return work(racing as typeof transaction);
        })
    } as DatabaseClient,
    auth: app.auth,
    requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
    requirePermission,
    requireClientAccess: createRequireClientAccess({ database: app.database }),
    photoUrlExpirySeconds: 300
  });
  await racingApp.ready();
  try {
    return await run(racingApp);
  } finally {
    await racingApp.close();
  }
};

const injectOn = async (target: FastifyInstance, method: 'POST', url: string, cookie: string, payload: unknown): Promise<Reply> =>
  (await target.inject({ method, url, headers: { ...origin, cookie }, payload: payload as Record<string, unknown> })) as unknown as Reply;

describe('CLIENTS conversation routes (#128 agency, #130 portal)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    await makeUser('admin', ADMIN_NAME);
    await makeUser('manager', MANAGER_NAME);
    await makeUser('production', 'Paulo Produção');
    await makeUser('sales', 'Vera Vendas');
    await makeUser('finance', 'Fábio Financeiro');
    await makeUser('viewOnly', 'Só Visualiza');
    await makeUser('operateOnly', 'Só Opera');
    await makeUser('ownerUser', OWNER_NAME);
    await makeUser('twoAgencies', 'Pessoa Duas Agências');
    await makeUser('otherAdmin', 'Admin da Outra');
    await makeUser('portalOne', PORTAL_ONE_NAME);
    await makeUser('portalTwo', PORTAL_TWO_NAME);
    await makeUser('portalOther', 'Portal Outro Cliente');
    await makeUser('portalB', 'Portal Outra Agência');
    await makeUser('portalRemoved', 'Portal Removido');
    await makeUser('dual', 'Pessoa Dupla');
    await makeUser('dualBare', 'Pessoa Dupla Sem Cliente');

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Conversa Agency A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Conversa Agency B', owner_user_id: null }
    ]);

    // Custom roles of ONE permission: an admin holds every key and hides a guard with the wrong one.
    const customRole = async (permission: string): Promise<string> => {
      const id = randomUUID();
      createdCustomRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${permission}-${id}`, name: `Só ${permission}`, is_system: false });
      await owner.knex('role_permissions').insert({ role_id: id, permission_key: permission });
      return id;
    };
    const viewOnlyRole = await customRole('cliente.visualizar');
    const operateOnlyRole = await customRole('cliente.operar');
    // An agency role with no cliente.* key at all, for the collaborator who also has a client link.
    const unrelatedRole = await customRole('midia.enviar');

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.production!.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: users.sales!.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: users.finance!.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: users.viewOnly!.id, role_id: viewOnlyRole },
      { agency_id: agencyA, user_id: users.operateOnly!.id, role_id: operateOnlyRole },
      { agency_id: agencyA, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: unrelatedRole }
    ]);

    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Conversa A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Conversa A2 ${clientA2}` },
      { id: clientB1, agency_id: agencyB, name: `Conversa B1 ${clientB1}` },
      { id: clientBare, agency_id: agencyA, name: `Conversa Bare ${clientBare}` },
      { id: clientArchived, agency_id: agencyA, name: `Conversa Arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() }
    ]);
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.portalOne!.id },
      { client_id: clientA1, user_id: users.portalTwo!.id },
      { client_id: clientA1, user_id: users.dual!.id },
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientArchived, user_id: users.dual!.id },
      { client_id: clientA1, user_id: users.portalRemoved!.id },
      { client_id: clientA2, user_id: users.portalOther!.id },
      { client_id: clientB1, user_id: users.portalB!.id },
      { client_id: clientBare, user_id: users.portalOne!.id },
      { client_id: clientArchived, user_id: users.portalOne!.id }
    ]);
    await owner.knex('client_personas').insert([
      { id: personaActive, client_id: clientA1, name: 'Persona ativa', updated_by: users.admin!.id },
      { id: personaArchived, client_id: clientA1, name: 'Persona arquivada', updated_by: users.admin!.id },
      { id: personaOfA2, client_id: clientA2, name: 'Persona do A2', updated_by: users.admin!.id }
    ]);
    await owner.knex('client_personas').where({ id: personaArchived }).update({ status: 'archived' });
    await owner.knex('client_brand_sections').insert({ client_id: clientA1, section_key: 'branding', body: 'Marca acolhedora.', updated_by: users.admin!.id });

    for (const key of Object.keys(users)) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB];
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

  describe('agency side (#128)', () => {
    it('lets account_manager open, comment and resolve, stamping the agency side from the route', async () => {
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' }, 'Vamos revisar o branding?');
      expect(opened.statusCode).toBe(201);
      const { thread, comment } = opened.json();
      expect(thread).toMatchObject({
        subject: { sectionKey: 'branding' },
        state: 'open',
        openedBy: { name: MANAGER_NAME, side: 'agency' },
        lastComment: { side: 'agency', excerpt: 'Vamos revisar o branding?' },
        commentCount: 1,
        resolvedBy: null,
        resolvedAt: null
      });
      expect(comment).toMatchObject({ body: 'Vamos revisar o branding?', side: 'agency', author: { name: MANAGER_NAME, photoUrl: null } });
      expect(await threadRow(thread.id)).toMatchObject({ client_id: clientA1, section_key: 'branding', persona_id: null, opened_by: users.manager!.id, opened_side: 'agency' });
      expect((await commentRows(thread.id)).map((row) => [row.author_side, row.author_user_id])).toEqual([['agency', users.manager!.id]]);

      const commented = await call('POST', `${agencyThreads(agencyA, clientA1)}/${thread.id}/comments`, cookies.manager!, { body: 'Segue o ajuste.' });
      expect(commented.statusCode).toBe(201);
      expect(commented.json()).toMatchObject({ body: 'Segue o ajuste.', side: 'agency', author: { name: MANAGER_NAME } });

      const resolved = await call('POST', `${agencyThreads(agencyA, clientA1)}/${thread.id}/resolve`, cookies.manager!);
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ id: thread.id, state: 'resolved', resolvedBy: { name: MANAGER_NAME }, commentCount: 2 });
      expect(await threadRow(thread.id)).toMatchObject({ resolved_by: users.manager!.id });
    });

    it('lets production, sales and finance read and answers 403 to the three writes, writing nothing', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'positioning' }, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientA1);
      const commentsBefore = await countComments(clientA1);

      for (const key of ['production', 'sales', 'finance']) {
        const cookie = cookies[key]!;
        expect((await call('GET', `${agencyThreads(agencyA, clientA1)}?${section('positioning')}`, cookie)).statusCode, `${key} list`).toBe(200);
        expect((await call('GET', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookie)).statusCode, `${key} comments`).toBe(200);
        expect((await openAs(cookie, agencyThreads(agencyA, clientA1), { sectionKey: 'positioning' })).statusCode, `${key} open`).toBe(403);
        expect((await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookie, { body: 'x' })).statusCode, `${key} comment`).toBe(403);
        expect((await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookie)).statusCode, `${key} resolve`).toBe(403);
      }
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect(await countComments(clientA1)).toBe(commentsBefore);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null, resolved_by: null });
    });

    it('guards reads with cliente.visualizar and writes with cliente.operar, each alone', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'observations' }, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const base = agencyThreads(agencyA, clientA1);

      // cliente.visualizar alone: reads yes, writes no.
      expect((await call('GET', `${base}?${section('observations')}`, cookies.viewOnly!)).statusCode).toBe(200);
      expect((await call('GET', `${base}/${threadId}/comments`, cookies.viewOnly!)).statusCode).toBe(200);
      expect((await openAs(cookies.viewOnly!, base, { sectionKey: 'observations' })).statusCode).toBe(403);
      expect((await call('POST', `${base}/${threadId}/comments`, cookies.viewOnly!, { body: 'x' })).statusCode).toBe(403);
      expect((await call('POST', `${base}/${threadId}/resolve`, cookies.viewOnly!)).statusCode).toBe(403);

      // cliente.operar alone: writes yes, reads no.
      expect((await call('GET', `${base}?${section('observations')}`, cookies.operateOnly!)).statusCode).toBe(403);
      expect((await call('GET', `${base}/${threadId}/comments`, cookies.operateOnly!)).statusCode).toBe(403);
      expect((await openAs(cookies.operateOnly!, base, { sectionKey: 'observations' })).statusCode).toBe(201);
      expect((await call('POST', `${base}/${threadId}/comments`, cookies.operateOnly!, { body: 'ok' })).statusCode).toBe(201);
      expect((await call('POST', `${base}/${threadId}/resolve`, cookies.operateOnly!)).statusCode).toBe(200);
    });

    it('lets the agency owner, who has no membership row, do everything', async () => {
      const opened = await openAs(cookies.ownerUser!, agencyThreads(agencyA, clientA1), { sectionKey: 'archetype' }, 'Do dono.');
      expect(opened.statusCode).toBe(201);
      // The owner has no link row to read a name from, so the author is unresolved rather than invented.
      expect(opened.json().comment.author).toBeNull();
      expect(opened.json().thread.openedBy).toEqual({ name: null, side: 'agency' });
      const resolved = await call('POST', `${agencyThreads(agencyA, clientA1)}/${opened.json().thread.id}/resolve`, cookies.ownerUser!);
      expect(resolved.statusCode).toBe(200);
      // The one case a resolver has no name: an owner with no link row to read it from.
      expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: null } });
    });

    it('names who resolved a thread even when they never commented on it, on both sides', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'positioning' }, [{ author: 'portalOne', side: 'client', at: '2026-01-01T10:00:00Z' }], '2026-01-02T10:00:00Z');
      expect(await threadRow(threadId)).toMatchObject({ resolved_by: users.admin!.id });
      const listedBy = async (url: string, cookie: string): Promise<unknown> =>
        (await call('GET', `${url}?${section('positioning')}&state=resolved&pageSize=100`, cookie)).json().data.find((item: { id: string }) => item.id === threadId);

      for (const listed of [
        await listedBy(agencyThreads(agencyA, clientA1), cookies.manager!),
        await listedBy(portalThreads(clientA1), cookies.portalOne!)
      ]) {
        expect(listed).toMatchObject({ state: 'resolved', resolvedBy: { name: ADMIN_NAME } });
      }
      const resolved = await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.manager!);
      expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: ADMIN_NAME } });
    });

    it('refuses a side in the body and writes the agency side regardless', async () => {
      const threadsBefore = await countThreads(clientA1);
      const refusedOpen = await call('POST', agencyThreads(agencyA, clientA1), cookies.manager!, { subject: { sectionKey: 'branding' }, body: 'x', side: 'client' });
      expect(refusedOpen.statusCode).toBe(400);
      expect(await countThreads(clientA1)).toBe(threadsBefore);

      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' });
      const commentsBefore = await countComments(clientA1);
      const refusedComment = await call('POST', `${agencyThreads(agencyA, clientA1)}/${opened.json().thread.id}/comments`, cookies.manager!, { body: 'x', side: 'client', authorSide: 'client' });
      expect(refusedComment.statusCode).toBe(400);
      expect(await countComments(clientA1)).toBe(commentsBefore);
      expect((await commentRows(opened.json().thread.id)).map((row) => row.author_side)).toEqual(['agency']);
    });

    it('validates the subject on open and on list', async () => {
      const base = agencyThreads(agencyA, clientA1);
      const threadsBefore = await countThreads(clientA1);
      expect((await openAs(cookies.manager!, base, { sectionKey: 'branding', personaId: personaActive })).statusCode).toBe(400);
      expect((await openAs(cookies.manager!, base, { sectionKey: 'logo' })).statusCode).toBe(400);
      expect((await openAs(cookies.manager!, base, {})).statusCode).toBe(400);
      expect((await openAs(cookies.manager!, base, { personaId: 'not-a-uuid' })).statusCode).toBe(400);
      expect(await countThreads(clientA1)).toBe(threadsBefore);

      expect((await call('GET', base, cookies.manager!)).statusCode).toBe(400);
      expect((await call('GET', `${base}?sectionKey=branding&personaId=${personaActive}`, cookies.manager!)).statusCode).toBe(400);
      expect((await call('GET', `${base}?sectionKey=logo`, cookies.manager!)).statusCode).toBe(400);
      expect((await call('GET', `${base}?sectionKey=branding&state=pending`, cookies.manager!)).statusCode).toBe(400);
      expect((await call('GET', `${base}?sectionKey=branding&unknown=1`, cookies.manager!)).statusCode).toBe(400);
      for (const key of ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations']) {
        expect((await call('GET', `${base}?${section(key)}`, cookies.manager!)).statusCode, key).toBe(200);
      }
    });

    it('answers 404 for a persona of another client, on open and on list', async () => {
      const base = agencyThreads(agencyA, clientA1);
      const threadsBefore = await countThreads(clientA1);
      expect((await openAs(cookies.manager!, base, { personaId: personaOfA2 })).statusCode).toBe(404);
      expect((await openAs(cookies.manager!, base, { personaId: randomUUID() })).statusCode).toBe(404);
      expect((await call('GET', `${base}?personaId=${personaOfA2}`, cookies.manager!)).statusCode).toBe(404);
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect((await openAs(cookies.manager!, base, { personaId: personaActive })).statusCode).toBe(201);
    });

    it('keeps a thread of an archived persona readable and refuses to write to it with 409', async () => {
      const threadId = await seedThread(clientA1, { personaId: personaArchived }, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const base = agencyThreads(agencyA, clientA1);
      const commentsBefore = await countComments(clientA1);
      const threadsBefore = await countThreads(clientA1);

      expect((await call('GET', `${base}?personaId=${personaArchived}`, cookies.manager!)).json().data.map((item: { id: string }) => item.id)).toContain(threadId);
      expect((await call('GET', `${base}/${threadId}/comments`, cookies.manager!)).statusCode).toBe(200);

      const comment = await call('POST', `${base}/${threadId}/comments`, cookies.manager!, { body: 'x' });
      expect(comment.statusCode).toBe(409);
      expect(comment.json().error.code).toBe('PERSONA_ARCHIVED');
      expect((await openAs(cookies.manager!, base, { personaId: personaArchived })).statusCode).toBe(409);
      expect((await call('POST', `${base}/${threadId}/resolve`, cookies.manager!)).statusCode).toBe(409);
      expect(await countComments(clientA1)).toBe(commentsBefore);
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null });
    });

    it('reopens a resolved thread when the client comments, and counts it as awaiting the agency', async () => {
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA2), { sectionKey: 'colors' }, 'Cores novas.');
      const threadId = opened.json().thread.id as string;
      await call('POST', `${agencyThreads(agencyA, clientA2)}/${threadId}/resolve`, cookies.manager!);
      const awaiting = async (): Promise<number> => {
        const listing = await call('GET', `/agencies/${agencyA}/clients?pageSize=100`, cookies.manager!);
        return (listing.json().data as { id: string; threadsAwaitingAgency: number }[]).find((item) => item.id === clientA2)!.threadsAwaitingAgency;
      };
      expect(await awaiting()).toBe(0);
      expect((await call('GET', `${agencyThreads(agencyA, clientA2)}?${section('colors')}&state=resolved`, cookies.manager!)).json().data).toHaveLength(1);

      // A2 is the client of portalOther: the portal comment reopens through the deferred trigger.
      const reply = await call('POST', `${portalThreads(clientA2)}/${threadId}/comments`, cookies.portalOther!, { body: 'Não gostei.' });
      expect(reply.statusCode).toBe(201);
      const after = (await call('GET', `${agencyThreads(agencyA, clientA2)}?${section('colors')}`, cookies.manager!)).json().data[0];
      expect(after).toMatchObject({ id: threadId, state: 'open', lastComment: { side: 'client' }, resolvedBy: null, resolvedAt: null });
      expect(await awaiting()).toBe(1);
      expect((await call('GET', `${agencyThreads(agencyA, clientA2)}?${section('colors')}&state=open`, cookies.manager!)).json().data).toHaveLength(1);
      expect((await call('GET', `${agencyThreads(agencyA, clientA2)}?${section('colors')}&state=resolved`, cookies.manager!)).json().data).toHaveLength(0);
    });

    it('reopens a resolved thread when the agency itself comments, without anyone writing to the thread', async () => {
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'tone_of_voice' });
      const threadId = opened.json().thread.id as string;
      await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.manager!);
      const stamp = (await threadRow(threadId))!.resolved_at;
      await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.manager!, { body: 'Mais uma coisa.' });
      const listed = (await call('GET', `${agencyThreads(agencyA, clientA1)}?${section('tone_of_voice')}`, cookies.manager!)).json().data.find((item: { id: string }) => item.id === threadId);
      expect(listed).toMatchObject({ state: 'open', resolvedBy: null, resolvedAt: null, commentCount: 2 });
      expect((await threadRow(threadId))!.resolved_at).toEqual(stamp);
    });

    it('keeps the first resolver and moment when a resolved thread is resolved again', async () => {
      const threadId = (await openAs(cookies.admin!, agencyThreads(agencyA, clientA1), { sectionKey: 'archetype' })).json().thread.id as string;
      const first = await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.admin!);
      expect(first.statusCode).toBe(200);
      const stamped = await threadRow(threadId);
      const second = await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.manager!);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: ADMIN_NAME } });
      expect(await threadRow(threadId)).toMatchObject({ resolved_by: users.admin!.id, resolved_at: stamped!.resolved_at });
      expect(iso(stamped!.resolved_at)).toBe(second.json().resolvedAt);
    });

    it('has no route to edit, delete or reopen anything', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'observations' }, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const commentId = (await commentRows(threadId))[0]!.id as string;
      const base = `${agencyThreads(agencyA, clientA1)}/${threadId}`;
      for (const [method, url] of [
        ['PATCH', `${base}/comments/${commentId}`],
        ['PUT', `${base}/comments/${commentId}`],
        ['DELETE', `${base}/comments/${commentId}`],
        ['DELETE', `${base}/comments`],
        ['DELETE', base],
        ['PATCH', base],
        ['POST', `${base}/reopen`],
        ['POST', `${base}/unresolve`]
      ] as const) {
        const reply = await call(method, url, cookies.admin!, method === 'DELETE' ? undefined : {});
        expect(reply.statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await commentRows(threadId))).toHaveLength(1);
    });

    it('refuses to open, comment and resolve for an archived client with 409, and still reads', async () => {
      const threadId = await seedThread(clientArchived, { sectionKey: 'branding' }, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const base = agencyThreads(agencyA, clientArchived);
      const commentsBefore = await countComments(clientArchived);
      const threadsBefore = await countThreads(clientArchived);

      for (const reply of [
        await openAs(cookies.admin!, base, { sectionKey: 'branding' }),
        await call('POST', `${base}/${threadId}/comments`, cookies.admin!, { body: 'x' }),
        await call('POST', `${base}/${threadId}/resolve`, cookies.admin!)
      ]) {
        expect(reply.statusCode).toBe(409);
        expect(reply.json().error.code).toBe('CLIENT_ARCHIVED');
      }
      expect((await call('GET', `${base}?${section('branding')}`, cookies.admin!)).json().data).toHaveLength(1);
      expect((await call('GET', `${base}/${threadId}/comments`, cookies.admin!)).statusCode).toBe(200);
      expect(await countComments(clientArchived)).toBe(commentsBefore);
      expect(await countThreads(clientArchived)).toBe(threadsBefore);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null });
    });

    it('validates the comment body: empty, blank, control characters and the 5000 byte cap', async () => {
      const base = agencyThreads(agencyA, clientA1);
      const threadId = (await openAs(cookies.manager!, base, { sectionKey: 'branding' })).json().thread.id as string;
      const commentsBefore = await countComments(clientA1);
      const threadsBefore = await countThreads(clientA1);

      for (const body of ['', '   ', '\n\t ', 'a\u0000b', 'a'.repeat(5001), '😀'.repeat(1251)]) {
        expect((await call('POST', `${base}/${threadId}/comments`, cookies.manager!, { body })).statusCode, JSON.stringify(body).slice(0, 20)).toBe(400);
        expect((await openAs(cookies.manager!, base, { sectionKey: 'branding' }, body)).statusCode).toBe(400);
      }
      expect((await call('POST', `${base}/${threadId}/comments`, cookies.manager!, { body: 12 })).statusCode).toBe(400);
      expect((await call('POST', `${base}/${threadId}/comments`, cookies.manager!, {})).statusCode).toBe(400);
      expect(await countComments(clientA1)).toBe(commentsBefore);
      expect(await countThreads(clientA1)).toBe(threadsBefore);

      const longest = await call('POST', `${base}/${threadId}/comments`, cookies.manager!, { body: 'a'.repeat(5000) });
      expect(longest.statusCode).toBe(201);
      expect(longest.json().body).toHaveLength(5000);
      const trimmed = await call('POST', `${base}/${threadId}/comments`, cookies.manager!, { body: '  linha 1\nlinha 2  ' });
      expect(trimmed.json().body).toBe('linha 1\nlinha 2');
    });

    it('lists threads 20 at a time, the most recently active first, with a stable total', async () => {
      const subject = { sectionKey: 'colors' };
      const ids: string[] = [];
      for (let index = 0; index < 23; index += 1) {
        const day = String(index + 1).padStart(2, '0');
        ids.push(await seedThread(clientBare, subject, [{ author: 'manager', side: 'agency', at: `2026-09-${day}T10:00:00Z` }]));
      }
      // The oldest thread receives the newest comment: activity, not creation, orders the list.
      await owner.knex('client_thread_comments').insert({
        thread_id: ids[0], client_id: clientBare, author_user_id: users.manager!.id, author_side: 'agency', body: 'recente', created_at: '2026-09-30T10:00:00Z'
      });

      const base = `${agencyThreads(agencyA, clientBare)}?${section('colors')}`;
      const first = (await call('GET', base, cookies.manager!)).json();
      expect(first.meta).toEqual({ page: 1, pageSize: 20, totalItems: 23, totalPages: 2 });
      expect(first.data).toHaveLength(20);
      expect(first.data[0]).toMatchObject({ id: ids[0], commentCount: 2, lastComment: { excerpt: 'recente' } });
      expect(first.data.slice(1).map((item: { id: string }) => item.id)).toEqual([...ids].slice(1).reverse().slice(0, 19));

      const second = (await call('GET', `${base}&page=2`, cookies.manager!)).json();
      expect(second.data.map((item: { id: string }) => item.id)).toEqual([...ids].slice(1).reverse().slice(19));
      expect(second.meta).toEqual({ page: 2, pageSize: 20, totalItems: 23, totalPages: 2 });

      const beyond = (await call('GET', `${base}&page=9`, cookies.manager!)).json();
      expect(beyond.data).toEqual([]);
      expect(beyond.meta.totalItems).toBe(23);

      const capped = (await call('GET', `${base}&pageSize=1000`, cookies.manager!)).json();
      expect(capped.meta.pageSize).toBe(100);
      expect(capped.data).toHaveLength(23);
      expect((await call('GET', `${base}&page=1e20`, cookies.manager!)).statusCode).toBe(400);
      expect((await call('GET', `${base}&page=0`, cookies.manager!)).statusCode).toBe(400);
    });

    it('breaks a tie of last activity by id, so a page boundary does not move', async () => {
      const at = '2026-08-01T10:00:00Z';
      const ids = [];
      for (let index = 0; index < 3; index += 1) ids.push(await seedThread(clientBare, { sectionKey: 'observations' }, [{ author: 'manager', side: 'agency', at }]));
      const url = `${agencyThreads(agencyA, clientBare)}?${section('observations')}`;
      const listed = (await call('GET', `${url}&pageSize=2`, cookies.manager!)).json().data.map((item: { id: string }) => item.id)
        .concat((await call('GET', `${url}&pageSize=2&page=2`, cookies.manager!)).json().data.map((item: { id: string }) => item.id));
      expect(listed).toEqual([...ids].sort().reverse());
    });

    it('lists comments 50 at a time, oldest first', async () => {
      const comments: SeedComment[] = Array.from({ length: 55 }, (_unused, index) => ({
        author: index % 2 === 0 ? 'manager' : 'portalOne',
        side: index % 2 === 0 ? 'agency' : 'client',
        body: `c${String(index).padStart(2, '0')}`,
        at: `2026-07-01T10:${String(index).padStart(2, '0')}:00Z`
      }));
      const threadId = await seedThread(clientBare, { sectionKey: 'tone_of_voice' }, comments);
      const base = `${agencyThreads(agencyA, clientBare)}/${threadId}/comments`;
      const first = (await call('GET', base, cookies.manager!)).json();
      expect(first.meta).toEqual({ page: 1, pageSize: 50, totalItems: 55, totalPages: 2 });
      expect(first.data.map((item: { body: string }) => item.body)).toEqual(comments.slice(0, 50).map((item) => item.body));
      const second = (await call('GET', `${base}?page=2`, cookies.manager!)).json();
      expect(second.data.map((item: { body: string }) => item.body)).toEqual(comments.slice(50).map((item) => item.body));
      expect((await call('GET', `${base}?pageSize=5000`, cookies.manager!)).json().meta.pageSize).toBe(100);
    });

    it('reads the author through the link of the comment\'s own side, with photo and a removed person\'s name', async () => {
      await app.pool.query('update auth."user" set image = $1 where id = $2', [`users/${users.manager!.id}/avatar/photo.png`, users.manager!.id]);
      const threadId = await seedThread(clientA1, { sectionKey: 'personas' }, [
        { author: 'manager', side: 'agency', body: 'da gestora', at: '2026-06-01T10:00:00Z' },
        { author: 'portalOne', side: 'client', body: 'da cliente', at: '2026-06-01T10:01:00Z' },
        { author: 'portalRemoved', side: 'client', body: 'de quem saiu', at: '2026-06-01T10:02:00Z' }
      ]);
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalRemoved!.id }).update({ status: 'removed' });
      try {
        const data = (await call('GET', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.manager!)).json().data as { body: string; side: string; author: { name: string; photoUrl: string | null } | null }[];
        expect(data.map((item) => [item.body, item.side, item.author?.name])).toEqual([
          ['da gestora', 'agency', MANAGER_NAME],
          ['da cliente', 'client', PORTAL_ONE_NAME],
          ['de quem saiu', 'client', 'Portal Removido']
        ]);
        expect(data[0]!.author!.photoUrl).toContain(`users/${users.manager!.id}/avatar/photo.png`);
        expect(data[1]!.author!.photoUrl).toBeNull();
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalRemoved!.id }).update({ status: 'active' });
        await app.pool.query('update auth."user" set image = null where id = $1', [users.manager!.id]);
      }
    });

    it('does not borrow a name for an author that has no link on the comment\'s side', async () => {
      // portalOne holds only a client link; a comment that claims the agency side must not resolve
      // through `auth."user"` by id, so the author stays unresolved.
      const threadId = await seedThread(clientA1, { sectionKey: 'observations' }, [
        { author: 'portalOne', side: 'agency', body: 'lado trocado', at: '2026-05-01T10:00:00Z' }
      ]);
      const data = (await call('GET', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.manager!)).json().data;
      expect(data).toEqual([expect.objectContaining({ body: 'lado trocado', side: 'agency', author: null })]);
    });

    it('answers 404 for the ids of another client, another agency and a malformed id, writing nothing', async () => {
      const ofA2 = await seedThread(clientA2, { sectionKey: 'branding' }, [{ author: 'manager', side: 'agency', at: '2026-04-01T10:00:00Z' }]);
      const ofB1 = await seedThread(clientB1, { sectionKey: 'branding' }, [{ author: 'otherAdmin', side: 'agency', at: '2026-04-01T10:00:00Z' }]);
      const commentsA2 = await countComments(clientA2);
      const commentsB1 = await countComments(clientB1);
      const base = agencyThreads(agencyA, clientA1);

      for (const threadId of [ofA2, ofB1, randomUUID(), 'not-a-uuid']) {
        expect((await call('GET', `${base}/${threadId}/comments`, cookies.admin!)).statusCode, `list ${threadId}`).toBe(404);
        expect((await call('POST', `${base}/${threadId}/comments`, cookies.admin!, { body: 'x' })).statusCode, `comment ${threadId}`).toBe(404);
        expect((await call('POST', `${base}/${threadId}/resolve`, cookies.admin!)).statusCode, `resolve ${threadId}`).toBe(404);
      }
      // A person of two agencies reaches agency B's client only through agency B's own path.
      expect((await call('GET', `${agencyThreads(agencyB, clientA1)}?${section('branding')}`, cookies.twoAgencies!)).statusCode).toBe(404);
      expect((await openAs(cookies.twoAgencies!, agencyThreads(agencyB, clientA1), { sectionKey: 'branding' })).statusCode).toBe(404);
      expect((await call('GET', `${agencyThreads(agencyA, clientB1)}?${section('branding')}`, cookies.twoAgencies!)).statusCode).toBe(404);
      // ...and a thread of agency B's client is not reachable through agency A's path either, even
      // though row-level security would show it to this person.
      const viaWrongAgency = `${agencyThreads(agencyA, clientB1)}/${ofB1}`;
      expect((await call('GET', `${viaWrongAgency}/comments`, cookies.twoAgencies!)).statusCode).toBe(404);
      expect((await call('POST', `${viaWrongAgency}/comments`, cookies.twoAgencies!, { body: 'x' })).statusCode).toBe(404);
      expect((await call('POST', `${viaWrongAgency}/resolve`, cookies.twoAgencies!)).statusCode).toBe(404);
      expect((await call('GET', `${agencyThreads(agencyB, clientB1)}/${ofB1}/comments`, cookies.twoAgencies!)).statusCode).toBe(200);
      expect((await call('GET', `${agencyThreads(agencyA, 'not-a-uuid')}?${section('branding')}`, cookies.admin!)).statusCode).toBe(404);
      expect((await call('GET', `${agencyThreads(agencyB, clientB1)}?${section('branding')}`, cookies.admin!)).statusCode).toBe(404);
      expect(await countComments(clientA2)).toBe(commentsA2);
      expect(await countComments(clientB1)).toBe(commentsB1);
      expect(await threadRow(ofA2)).toMatchObject({ resolved_at: null });
      expect(await threadRow(ofB1)).toMatchObject({ resolved_at: null });
    });

    it('rejects an unauthenticated caller and a portal person on the agency routes', async () => {
      expect((await app.app.inject({ method: 'GET', url: `${agencyThreads(agencyA, clientA1)}?${section('branding')}`, headers: origin })).statusCode).toBe(401);
      expect((await call('GET', `${agencyThreads(agencyA, clientA1)}?${section('branding')}`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await openAs(cookies.portalOne!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' })).statusCode).toBe(404);
    });
  });

  describe('write races', () => {
    const racing = (statement: string, beforeFailure?: () => Promise<void>) => ({ statement, failure: 'rls' as const, beforeFailure });

    it('answers 409 CLIENT_ARCHIVED when the client is archived between the check and the write', async () => {
      const clientId = randomUUID();
      await owner.knex('clients').insert({ id: clientId, agency_id: agencyA, name: `Conversa corrida ${clientId}` });
      await withRacingApp(racing('insert into public.client_threads', async () => {
        await owner.knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
      }), async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', agencyThreads(agencyA, clientId), cookies.admin!, { subject: { sectionKey: 'branding' }, body: 'x' });
        expect(reply.statusCode).toBe(409);
        expect(reply.json().code).toBe('CLIENT_ARCHIVED');
      });
      expect(await countThreads(clientId)).toBe(0);
    });

    it('answers 409 PERSONA_ARCHIVED when the persona is archived between the check and the write', async () => {
      const persona = randomUUID();
      await owner.knex('client_personas').insert({ id: persona, client_id: clientA1, name: 'Persona da corrida', updated_by: users.admin!.id });
      const threadsBefore = await countThreads(clientA1);
      await withRacingApp(racing('insert into public.client_threads', async () => {
        await owner.knex('client_personas').where({ id: persona }).update({ status: 'archived' });
      }), async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject: { personaId: persona }, body: 'x' });
        expect(reply.statusCode).toBe(409);
        expect(reply.json().code).toBe('PERSONA_ARCHIVED');
      });
      expect(await countThreads(clientA1)).toBe(threadsBefore);
    });

    it('answers 403, not 500, when row-level security refuses a write that no state change explains', async () => {
      await withRacingApp(racing('insert into public.client_threads'), async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject: { sectionKey: 'branding' }, body: 'x' });
        expect(reply.statusCode).toBe(403);
      });
    });

    it('answers 409 when the persona is archived between the check and the comment, and when the resolve matches no row', async () => {
      const persona = randomUUID();
      await owner.knex('client_personas').insert({ id: persona, client_id: clientA1, name: 'Persona do comentário', updated_by: users.admin!.id });
      const threadId = await seedThread(clientA1, { personaId: persona }, [{ author: 'manager', side: 'agency', at: '2026-03-01T10:00:00Z' }]);
      const archive = async () => { await owner.knex('client_personas').where({ id: persona }).update({ status: 'archived' }); };

      await withRacingApp(racing('insert into public.client_thread_comments', archive), async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.admin!, { body: 'x' });
        expect(reply.statusCode).toBe(409);
        expect(reply.json().code).toBe('PERSONA_ARCHIVED');
      });
      await owner.knex('client_personas').where({ id: persona }).update({ status: 'active' });
      await withRacingApp({ statement: 'update public.client_threads', failure: 'empty', beforeFailure: archive }, async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.admin!, undefined);
        expect(reply.statusCode).toBe(409);
        expect(reply.json().code).toBe('PERSONA_ARCHIVED');
      });
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null });
    });

    it('refuses an archived client or persona before attempting the write, not only after the database refuses it', async () => {
      const personaThread = await seedThread(clientA1, { personaId: personaArchived }, [{ author: 'manager', side: 'agency', at: '2026-03-02T10:00:00Z' }]);
      const archivedClientThread = await seedThread(clientArchived, { sectionKey: 'colors' }, [{ author: 'manager', side: 'agency', at: '2026-03-02T10:00:00Z' }]);
      const attempts: string[] = [];
      const note = (label: string) => async () => { attempts.push(label); };
      const cases = [
        { label: 'open on an archived persona', statement: 'insert into public.client_threads', url: agencyThreads(agencyA, clientA1), payload: { subject: { personaId: personaArchived }, body: 'x' } },
        { label: 'comment on an archived persona', statement: 'insert into public.client_thread_comments', url: `${agencyThreads(agencyA, clientA1)}/${personaThread}/comments`, payload: { body: 'x' } },
        { label: 'open on an archived client', statement: 'insert into public.client_threads', url: agencyThreads(agencyA, clientArchived), payload: { subject: { sectionKey: 'colors' }, body: 'x' } },
        { label: 'comment on an archived client', statement: 'insert into public.client_thread_comments', url: `${agencyThreads(agencyA, clientArchived)}/${archivedClientThread}/comments`, payload: { body: 'x' } },
        { label: 'resolve on an archived persona', statement: 'update public.client_threads', url: `${agencyThreads(agencyA, clientA1)}/${personaThread}/resolve`, payload: undefined }
      ];
      for (const item of cases) {
        await withRacingApp({ statement: item.statement, failure: 'rls', beforeFailure: note(item.label) }, async (racingApp) => {
          const reply = await injectOn(racingApp, 'POST', item.url, cookies.admin!, item.payload);
          expect(reply.statusCode, item.label).toBe(409);
        });
      }
      expect(attempts).toEqual([]);
    });

    it('answers 404 on the portal when its client link goes away between the check and the write', async () => {
      await withRacingApp(racing('insert into public.client_threads'), async (racingApp) => {
        const reply = await injectOn(racingApp, 'POST', portalThreads(clientA1), cookies.portalOne!, { subject: { sectionKey: 'branding' }, body: 'x' });
        expect(reply.statusCode).toBe(404);
      });
    });
  });

  describe('portal side (#130)', () => {
    it('lets a person with an active link open a thread and comment, recording the client side', async () => {
      const opened = await openAs(cookies.portalOne!, portalThreads(clientA1), { sectionKey: 'branding' }, 'Posso sugerir uma mudança?');
      expect(opened.statusCode).toBe(201);
      const { thread, comment } = opened.json();
      expect(thread).toMatchObject({ openedBy: { name: PORTAL_ONE_NAME, side: 'client' }, state: 'open', lastComment: { side: 'client' }, commentCount: 1 });
      expect(comment).toMatchObject({ side: 'client', author: { name: PORTAL_ONE_NAME } });
      expect(await threadRow(thread.id)).toMatchObject({ client_id: clientA1, opened_by: users.portalOne!.id, opened_side: 'client' });
      expect((await commentRows(thread.id)).map((row) => row.author_side)).toEqual(['client']);

      const replied = await call('POST', `${portalThreads(clientA1)}/${thread.id}/comments`, cookies.portalTwo!, { body: 'Concordo.' });
      expect(replied.statusCode).toBe(201);
      expect(replied.json()).toMatchObject({ side: 'client', author: { name: PORTAL_TWO_NAME } });
      expect((await commentRows(thread.id)).map((row) => [row.author_side, row.author_user_id])).toEqual([
        ['client', users.portalOne!.id],
        ['client', users.portalTwo!.id]
      ]);
    });

    it('shows the portal the same threads, the same shape and the agency authors\' names', async () => {
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' }, 'Resposta da agência.');
      const threadId = opened.json().thread.id as string;
      await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalOne!, { body: 'Obrigada!' });

      const fromPortal = (await call('GET', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalTwo!)).json();
      const fromAgency = (await call('GET', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.manager!)).json();
      expect(fromPortal).toEqual(fromAgency);
      expect(fromPortal.data.map((item: { side: string; author: { name: string } }) => [item.side, item.author.name])).toEqual([
        ['agency', MANAGER_NAME],
        ['client', PORTAL_ONE_NAME]
      ]);

      const listPortal = (await call('GET', `${portalThreads(clientA1)}?${section('branding')}`, cookies.portalTwo!)).json();
      const listAgency = (await call('GET', `${agencyThreads(agencyA, clientA1)}?${section('branding')}`, cookies.manager!)).json();
      expect(listPortal).toEqual(listAgency);
      expect(listPortal.meta.pageSize).toBe(20);
    });

    it('answers 404 to a person of client A reading or writing a thread of client B in the same agency', async () => {
      const ofA2 = await seedThread(clientA2, { sectionKey: 'branding' }, [{ author: 'portalOther', side: 'client', at: '2026-02-01T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientA2);
      const commentsBefore = await countComments(clientA2);

      expect((await call('GET', `${portalThreads(clientA2)}?${section('branding')}`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await openAs(cookies.portalOne!, portalThreads(clientA2), { sectionKey: 'branding' })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA2)}/${ofA2}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA2)}/${ofA2}/comments`, cookies.portalOne!, { body: 'x' })).statusCode).toBe(404);
      // The thread of A2 under A1's own path is the same 404, never a leak by id.
      expect((await call('GET', `${portalThreads(clientA1)}/${ofA2}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA1)}/${ofA2}/comments`, cookies.portalOne!, { body: 'x' })).statusCode).toBe(404);
      // portalOne holds an active link to the bare client too, so row-level security would show them
      // that thread: only the client in the path keeps it out of A1's conversation.
      const ofBare = await seedThread(clientBare, { sectionKey: 'branding' }, [{ author: 'portalOne', side: 'client', at: '2026-02-02T10:00:00Z' }]);
      const bareComments = await countComments(clientBare);
      expect((await call('GET', `${portalThreads(clientA1)}/${ofBare}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA1)}/${ofBare}/comments`, cookies.portalOne!, { body: 'x' })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientBare)}/${ofBare}/comments`, cookies.portalOne!)).statusCode).toBe(200);
      expect(await countComments(clientBare)).toBe(bareComments);
      expect((await call('GET', `${portalThreads(clientB1)}?${section('branding')}`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA1)}/${randomUUID()}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA1)}/not-a-uuid/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect(await countThreads(clientA2)).toBe(threadsBefore);
      expect(await countComments(clientA2)).toBe(commentsBefore);
    });

    it('answers 404 to an agency collaborator without a client link, owner and admin included, on every portal route', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'branding' }, [{ author: 'portalOne', side: 'client', at: '2026-01-05T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientA1);
      const commentsBefore = await countComments(clientA1);
      for (const key of ['ownerUser', 'admin', 'manager', 'twoAgencies']) {
        const cookie = cookies[key]!;
        expect((await call('GET', `${portalThreads(clientA1)}?${section('branding')}`, cookie)).statusCode, `${key} list`).toBe(404);
        expect((await openAs(cookie, portalThreads(clientA1), { sectionKey: 'branding' })).statusCode, `${key} open`).toBe(404);
        expect((await call('GET', `${portalThreads(clientA1)}/${threadId}/comments`, cookie)).statusCode, `${key} comments`).toBe(404);
        expect((await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, cookie, { body: 'x' })).statusCode, `${key} comment`).toBe(404);
      }
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect(await countComments(clientA1)).toBe(commentsBefore);
    });

    it('lets a collaborator who also has a client link write as client on the portal and as agency on the agency routes', async () => {
      const viaPortal = await openAs(cookies.dual!, portalThreads(clientA1), { sectionKey: 'branding' }, 'Pelo portal.');
      expect(viaPortal.statusCode).toBe(201);
      expect(viaPortal.json().comment.side).toBe('client');
      expect(await threadRow(viaPortal.json().thread.id)).toMatchObject({ opened_side: 'client', opened_by: users.dual!.id });

      const viaAgency = await openAs(cookies.dual!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' }, 'Pela agência.');
      expect(viaAgency.statusCode).toBe(201);
      expect(viaAgency.json().comment.side).toBe('agency');
      expect(await threadRow(viaAgency.json().thread.id)).toMatchObject({ opened_side: 'agency', opened_by: users.dual!.id });

      const portalComment = await call('POST', `${portalThreads(clientA1)}/${viaAgency.json().thread.id}/comments`, cookies.dual!, { body: 'Como cliente.' });
      const agencyComment = await call('POST', `${agencyThreads(agencyA, clientA1)}/${viaPortal.json().thread.id}/comments`, cookies.dual!, { body: 'Como agência.' });
      expect([portalComment.json().side, agencyComment.json().side]).toEqual(['client', 'agency']);
      expect((await commentRows(viaAgency.json().thread.id)).map((row) => row.author_side)).toEqual(['agency', 'client']);
      expect((await commentRows(viaPortal.json().thread.id)).map((row) => row.author_side)).toEqual(['client', 'agency']);
    });

    // A person who is a collaborator AND has a client link crosses row-level security through its
    // agency branch, so every portal rule that RLS would enforce for a plain portal person has to hold
    // by the route's own filter as well. These tests run every portal route as that person.
    const portalRoutesAs = async (cookie: string, clientId: string, threadId: string, subject: Record<string, unknown>): Promise<number[]> => [
      (await call('GET', `${portalThreads(clientId)}?${new URLSearchParams(subject as Record<string, string>).toString()}`, cookie)).statusCode,
      (await openAs(cookie, portalThreads(clientId), subject)).statusCode,
      (await call('GET', `${portalThreads(clientId)}/${threadId}/comments`, cookie)).statusCode,
      (await call('POST', `${portalThreads(clientId)}/${threadId}/comments`, cookie, { body: 'x' })).statusCode
    ];

    it('treats an archived persona as nonexistent for a collaborator with a client link too, on every portal route', async () => {
      const threadId = await seedThread(clientA1, { personaId: personaArchived }, [{ author: 'manager', side: 'agency', at: '2026-01-09T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientA1);
      const commentsBefore = await countComments(clientA1);
      for (const key of ['dual', 'dualBare']) {
        expect(await portalRoutesAs(cookies[key]!, clientA1, threadId, { personaId: personaArchived }), key).toEqual([404, 404, 404, 404]);
      }
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect(await countComments(clientA1)).toBe(commentsBefore);

      // The same person, through the agency routes, is still the agency: it reads the archived persona.
      expect((await call('GET', `${agencyThreads(agencyA, clientA1)}?personaId=${personaArchived}`, cookies.dual!)).json().data.map((item: { id: string }) => item.id)).toContain(threadId);
      expect((await call('GET', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.dual!)).statusCode).toBe(200);
      expect((await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, cookies.dual!, { body: 'x' })).statusCode).toBe(409);
    });

    it('lets a collaborator whose role has no cliente permission act on the portal only as the client person', async () => {
      const bare = cookies.dualBare!;
      const opened = await openAs(bare, portalThreads(clientA1), { sectionKey: 'branding' }, 'Como cliente.');
      expect(opened.statusCode).toBe(201);
      expect(opened.json().comment.side).toBe('client');
      const threadId = opened.json().thread.id as string;
      expect((await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, bare, { body: 'De novo.' })).json().side).toBe('client');
      expect((await call('GET', `${portalThreads(clientA1)}?${section('branding')}`, bare)).statusCode).toBe(200);
      expect((await call('GET', `${portalThreads(clientA1)}/${threadId}/comments`, bare)).statusCode).toBe(200);
      expect((await commentRows(threadId)).map((row) => row.author_side)).toEqual(['client', 'client']);
      expect(await threadRow(threadId)).toMatchObject({ opened_side: 'client' });

      // No agency permission leaks across: the agency routes still refuse every one of them.
      const agency = agencyThreads(agencyA, clientA1);
      expect((await call('GET', `${agency}?${section('branding')}`, bare)).statusCode).toBe(403);
      expect((await call('GET', `${agency}/${threadId}/comments`, bare)).statusCode).toBe(403);
      expect((await openAs(bare, agency, { sectionKey: 'branding' })).statusCode).toBe(403);
      expect((await call('POST', `${agency}/${threadId}/comments`, bare, { body: 'x' })).statusCode).toBe(403);
      expect((await call('POST', `${agency}/${threadId}/resolve`, bare)).statusCode).toBe(403);
      expect((await commentRows(threadId))).toHaveLength(2);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null });
    });

    it('keeps the conversation of the client in the path for a collaborator who reads every client of the agency', async () => {
      const ofA2 = await seedThread(clientA2, { sectionKey: 'branding' }, [{ author: 'manager', side: 'agency', at: '2026-01-10T10:00:00Z' }]);
      const commentsBefore = await countComments(clientA2);
      expect((await call('GET', `${portalThreads(clientA1)}/${ofA2}/comments`, cookies.dual!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA1)}/${ofA2}/comments`, cookies.dual!, { body: 'x' })).statusCode).toBe(404);
      // Client A2 has no link for this person: the portal guard refuses it, the agency routes do not.
      expect((await call('GET', `${portalThreads(clientA2)}?${section('branding')}`, cookies.dual!)).statusCode).toBe(404);
      expect((await openAs(cookies.dual!, portalThreads(clientA2), { sectionKey: 'branding' })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA2)}/${ofA2}/comments`, cookies.dual!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA2)}/${ofA2}/comments`, cookies.dual!, { body: 'x' })).statusCode).toBe(404);
      expect(await countComments(clientA2)).toBe(commentsBefore);
      expect((await call('GET', `${agencyThreads(agencyA, clientA2)}/${ofA2}/comments`, cookies.dual!)).statusCode).toBe(200);
    });

    it('answers a collaborator with a client link exactly what it answers a plain portal person, on the reads', async () => {
      const threadId = (await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'observations' }, 'Para a cliente.')).json().thread.id as string;
      await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalOne!, { body: 'Resposta.' });
      for (const url of [`${portalThreads(clientA1)}?${section('observations')}&pageSize=100`, `${portalThreads(clientA1)}/${threadId}/comments`]) {
        const plain = await call('GET', url, cookies.portalOne!);
        for (const key of ['dual', 'dualBare']) {
          const crossing = await call('GET', url, cookies[key]!);
          expect(crossing.statusCode, `${key} ${url}`).toBe(200);
          expect(crossing.json(), `${key} ${url}`).toEqual(plain.json());
        }
      }
    });

    it('answers 404 on every portal route once the link of a collaborator who also has one is removed, while the agency routes stay open', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'branding' }, [{ author: 'portalOne', side: 'client', at: '2026-01-11T10:00:00Z' }]);
      expect(await portalRoutesAs(cookies.dual!, clientA1, threadId, { sectionKey: 'branding' })).toEqual([200, 201, 200, 201]);
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.dual!.id }).update({ status: 'removed' });
      try {
        const threadsBefore = await countThreads(clientA1);
        const commentsBefore = await countComments(clientA1);
        expect(await portalRoutesAs(cookies.dual!, clientA1, threadId, { sectionKey: 'branding' })).toEqual([404, 404, 404, 404]);
        expect(await countThreads(clientA1)).toBe(threadsBefore);
        expect(await countComments(clientA1)).toBe(commentsBefore);
        expect((await call('GET', `${agencyThreads(agencyA, clientA1)}?${section('branding')}`, cookies.dual!)).statusCode).toBe(200);
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.dual!.id }).update({ status: 'active' });
      }
    });

    it('answers 404 on every portal route for an archived client to a collaborator who also has a link, while the agency still reads it', async () => {
      const threadId = await seedThread(clientArchived, { sectionKey: 'branding' }, [{ author: 'manager', side: 'agency', at: '2026-01-12T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientArchived);
      const commentsBefore = await countComments(clientArchived);
      expect(await portalRoutesAs(cookies.dual!, clientArchived, threadId, { sectionKey: 'branding' })).toEqual([404, 404, 404, 404]);
      expect(await countThreads(clientArchived)).toBe(threadsBefore);
      expect(await countComments(clientArchived)).toBe(commentsBefore);
      expect((await call('GET', `${agencyThreads(agencyA, clientArchived)}?${section('branding')}`, cookies.dual!)).statusCode).toBe(200);
      expect((await call('GET', `${agencyThreads(agencyA, clientArchived)}/${threadId}/comments`, cookies.dual!)).statusCode).toBe(200);
    });

    it('answers 404 on the next request after the link is removed, without a new login', async () => {
      const cookie = cookies.portalRemoved!;
      expect((await call('GET', `${portalThreads(clientA1)}?${section('branding')}`, cookie)).statusCode).toBe(200);
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalRemoved!.id }).update({ status: 'removed' });
      try {
        const threadsBefore = await countThreads(clientA1);
        expect((await call('GET', `${portalThreads(clientA1)}?${section('branding')}`, cookie)).statusCode).toBe(404);
        expect((await openAs(cookie, portalThreads(clientA1), { sectionKey: 'branding' })).statusCode).toBe(404);
        expect(await countThreads(clientA1)).toBe(threadsBefore);
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalRemoved!.id }).update({ status: 'active' });
      }
    });

    it('answers 404 for an archived client, on every portal route', async () => {
      const threadId = await seedThread(clientArchived, { sectionKey: 'branding' }, [{ author: 'portalOne', side: 'client', at: '2026-01-06T10:00:00Z' }]);
      const commentsBefore = await countComments(clientArchived);
      expect((await call('GET', `${portalThreads(clientArchived)}?${section('branding')}`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await openAs(cookies.portalOne!, portalThreads(clientArchived), { sectionKey: 'branding' })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientArchived)}/${threadId}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientArchived)}/${threadId}/comments`, cookies.portalOne!, { body: 'x' })).statusCode).toBe(404);
      expect(await countComments(clientArchived)).toBe(commentsBefore);
    });

    it('treats an archived persona as nonexistent: list, open, read and comment all answer 404', async () => {
      const threadId = await seedThread(clientA1, { personaId: personaArchived }, [{ author: 'manager', side: 'agency', at: '2026-01-07T10:00:00Z' }]);
      const threadsBefore = await countThreads(clientA1);
      const commentsBefore = await countComments(clientA1);
      expect((await call('GET', `${portalThreads(clientA1)}?personaId=${personaArchived}`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await openAs(cookies.portalOne!, portalThreads(clientA1), { personaId: personaArchived })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalOne!, { body: 'x' })).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(clientA1)}?personaId=${personaOfA2}`, cookies.portalOne!)).statusCode).toBe(404);
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      expect(await countComments(clientA1)).toBe(commentsBefore);
      expect((await openAs(cookies.portalOne!, portalThreads(clientA1), { personaId: personaActive })).statusCode).toBe(201);
    });

    it('refuses a new thread on a section the agency has not filled with 409, and accepts it once filled', async () => {
      const base = portalThreads(clientBare);
      const threadsBefore = await countThreads(clientBare);
      for (const key of ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations']) {
        const reply = await openAs(cookies.portalOne!, base, { sectionKey: key });
        expect(reply.statusCode, key).toBe(409);
        expect(reply.json().error.code).toBe('SECTION_NOT_FILLED');
      }
      expect(await countThreads(clientBare)).toBe(threadsBefore);

      await owner.knex('client_brand_sections').insert({ client_id: clientBare, section_key: 'colors', colors: JSON.stringify([{ name: 'Vinho', hex: '#7A1F2B' }]), updated_by: users.admin!.id });
      await owner.knex('client_brand_sections').insert({ client_id: clientBare, section_key: 'positioning', body: '   ', updated_by: users.admin!.id });
      await owner.knex('client_personas').insert({ id: randomUUID(), client_id: clientBare, name: 'Persona da seção', updated_by: users.admin!.id });
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'colors' })).statusCode).toBe(201);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'personas' })).statusCode).toBe(201);
      // A blank body is not a filled section: the same rule the study's "preenchimento" counts.
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'positioning' })).statusCode).toBe(409);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'archetype' })).statusCode).toBe(409);
      // The agency is not held to it: it is the one that fills the section.
      expect((await openAs(cookies.manager!, agencyThreads(agencyA, clientBare), { sectionKey: 'archetype' })).statusCode).toBe(201);
    });

    it('reopens a resolved thread when the portal comments, which the portal can never resolve itself', async () => {
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), { sectionKey: 'branding' });
      const threadId = opened.json().thread.id as string;
      await call('POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, cookies.manager!);
      expect((await call('GET', `${portalThreads(clientA1)}?${section('branding')}&state=resolved`, cookies.portalOne!)).json().data.map((item: { id: string }) => item.id)).toContain(threadId);

      await call('POST', `${portalThreads(clientA1)}/${threadId}/comments`, cookies.portalOne!, { body: 'Mais uma ideia.' });
      const listed = (await call('GET', `${portalThreads(clientA1)}?${section('branding')}&state=open`, cookies.portalOne!)).json().data.find((item: { id: string }) => item.id === threadId);
      expect(listed).toMatchObject({ state: 'open', lastComment: { side: 'client' } });
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null, resolved_by: null });
    });

    it('has no resolve on the portal: the route does not exist and the thread stays open', async () => {
      const threadId = await seedThread(clientA1, { sectionKey: 'branding' }, [{ author: 'portalOne', side: 'client', at: '2026-01-08T10:00:00Z' }]);
      for (const url of [`${portalThreads(clientA1)}/${threadId}/resolve`, `${portalThreads(clientA1)}/${threadId}/reopen`]) {
        expect((await call('POST', url, cookies.portalOne!, {})).statusCode, url).toBe(404);
      }
      expect((await call('PATCH', `${portalThreads(clientA1)}/${threadId}`, cookies.portalOne!, { resolved: true })).statusCode).toBe(404);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null, resolved_by: null });
    });

    it('refuses a side in the body and validates the subject and the text like the agency routes', async () => {
      const base = portalThreads(clientA1);
      const threadsBefore = await countThreads(clientA1);
      expect((await call('POST', base, cookies.portalOne!, { subject: { sectionKey: 'branding' }, body: 'x', side: 'agency' })).statusCode).toBe(400);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'branding', personaId: personaActive })).statusCode).toBe(400);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'logo' })).statusCode).toBe(400);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'branding' }, '   ')).statusCode).toBe(400);
      expect((await openAs(cookies.portalOne!, base, { sectionKey: 'branding' }, 'a'.repeat(5001))).statusCode).toBe(400);
      expect((await call('GET', base, cookies.portalOne!)).statusCode).toBe(400);
      expect((await call('GET', `${base}?sectionKey=branding&personaId=${personaActive}`, cookies.portalOne!)).statusCode).toBe(400);
      expect(await countThreads(clientA1)).toBe(threadsBefore);
      const threadId = (await openAs(cookies.portalOne!, base, { sectionKey: 'branding' })).json().thread.id as string;
      const commentsBefore = await countComments(clientA1);
      expect((await call('POST', `${base}/${threadId}/comments`, cookies.portalOne!, { body: 'x', side: 'agency' })).statusCode).toBe(400);
      expect(await countComments(clientA1)).toBe(commentsBefore);
    });

    it('rejects an unauthenticated caller', async () => {
      expect((await app.app.inject({ method: 'GET', url: `${portalThreads(clientA1)}?${section('branding')}`, headers: origin })).statusCode).toBe(401);
      expect((await app.app.inject({ method: 'POST', url: portalThreads(clientA1), headers: origin, payload: { subject: { sectionKey: 'branding' }, body: 'x' } })).statusCode).toBe(401);
    });
  });
});
