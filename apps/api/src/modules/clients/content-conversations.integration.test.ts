import { randomUUID } from 'node:crypto';

import { raw, type DatabaseClient } from '@ageniza/database';
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
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';

// Issue #259: the conversation of a content, over the conversation routes of Clientes (#128 agency, #130 portal). A content
// has one conversation, the agency writes in it with `conteudo.operar` and `conteudo.visualizar` and not with `cliente.operar`,
// and the portal only while the content is open to the client. Every scenario that proves isolation uses a person who belongs
// to more than one tenant, so a missing filter shows up as a leaked row instead of being hidden by row-level security.
const origin = { origin: TEST_APP_PUBLIC_URL };

// Invisible characters are spelled as code points so they stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);

type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
const OPEN_STATUSES: readonly Status[] = ['awaiting_approval', 'adjusting', 'approved', 'published'];
const CLOSED_STATUSES: readonly Status[] = ['in_production', 'cancelled'];

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const contentIds: string[] = [];
const extraClientIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const clientArchived = randomUUID();
const clientCounters = randomUUID();

const sessionCookieHeader = (cookiesList: readonly { name: string; value: string }[]): string =>
  cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `content-conv-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const injectOn = async (target: FastifyInstance, method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown): Promise<Reply> =>
  (await target.inject({ method, url, headers: { ...origin, cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })) as unknown as Reply;

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown): Promise<Reply> => injectOn(app.app, method, url, cookie, payload);

const agencyThreads = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/threads`;
const portalThreads = (clientId: string): string => `/clients/${clientId}/threads`;

const openAs = (cookie: string, url: string, contentId: string, body = 'Primeiro comentário', target: FastifyInstance = app.app): Promise<Reply> =>
  injectOn(target, 'POST', url, cookie, { subject: { contentId }, body });

const commentAs = (cookie: string, url: string, threadId: string, body = 'Outro comentário', target: FastifyInstance = app.app): Promise<Reply> =>
  injectOn(target, 'POST', `${url}/${threadId}/comments`, cookie, { body });

const listAs = (cookie: string, url: string, contentId: string, query = ''): Promise<Reply> =>
  call('GET', `${url}?contentId=${contentId}${query}`, cookie);

const commentsAs = (cookie: string, url: string, threadId: string): Promise<Reply> => call('GET', `${url}/${threadId}/comments`, cookie);

const resolveAs = (cookie: string, url: string, threadId: string, target: FastifyInstance = app.app): Promise<Reply> =>
  injectOn(target, 'POST', `${url}/${threadId}/resolve`, cookie, {});

const defaultFolder = async (clientId: string): Promise<string> =>
  (await owner.knex('media_folders').where({ client_id: clientId, name: 'Imagens', is_default: true }).first('id')).id as string;

/** A content in the given state, written as the schema owner: the state of a content is only ever moved by functions. */
const seedContent = async (clientId: string, status: Status): Promise<string> => {
  const id = randomUUID();
  contentIds.push(id);
  const approved = status === 'approved' || status === 'published';
  await owner.knex('contents').insert({
    id,
    client_id: clientId,
    title: `Conteúdo ${id.slice(0, 8)}`,
    platform: 'instagram',
    format: 'image',
    publish_on: '2026-10-20',
    folder_id: await defaultFolder(clientId),
    owner_user_id: users[clientId === clientB1 ? 'otherAdmin' : 'manager']!.id,
    status,
    ...(approved ? { approved_by: users[clientId === clientB1 ? 'otherAdmin' : 'manager']!.id, approved_at: new Date() } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: new Date() } : {}),
    ...(status === 'cancelled' ? { cancelled_at: new Date() } : {})
  });
  return id;
};

const moveContent = async (contentId: string, status: 'in_production' | 'awaiting_approval' | 'cancelled'): Promise<void> => {
  await owner.knex('contents').where({ id: contentId }).update({ status, cancelled_at: status === 'cancelled' ? new Date() : null });
};

interface SeedComment {
  readonly author: string;
  readonly side: 'agency' | 'client';
  readonly body?: string;
  readonly at: string;
}

/** The conversation of a content with its comments, as the schema owner, with chosen dates. */
const seedContentThread = async (clientId: string, contentId: string, comments: readonly SeedComment[], resolvedAt?: string): Promise<string> => {
  const id = randomUUID();
  const first = comments[0];
  if (first === undefined) throw new Error('A thread needs a first comment.');
  await owner.knex('client_threads').insert({
    id,
    client_id: clientId,
    content_id: contentId,
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
  if (resolvedAt !== undefined) await owner.knex('client_threads').where({ id }).update({ resolved_at: resolvedAt, resolved_by: users.admin!.id });
  return id;
};

const threadRow = (threadId: string): Promise<Record<string, unknown> | undefined> => owner.knex('client_threads').where({ id: threadId }).first();

const commentRows = (threadId: string): Promise<Record<string, unknown>[]> =>
  owner.knex('client_thread_comments').where({ thread_id: threadId }).orderBy('created_at', 'asc');

const threadsOfContent = (contentId: string): Promise<Record<string, unknown>[]> => owner.knex('client_threads').where({ content_id: contentId });

const countThreads = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_threads').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const countComments = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_thread_comments').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

/** What is written to the conversation tables in a state a refused call must leave alone. */
const snapshotOf = async (clientId: string): Promise<{ threads: number; comments: number; resolved: number }> => ({
  threads: await countThreads(clientId),
  comments: await countComments(clientId),
  resolved: Number((await owner.knex('client_threads').where({ client_id: clientId }).whereNotNull('resolved_at').count<{ count: string }[]>('id as count'))[0]?.count ?? 0)
});

const newClient = async (label: string, portalUser?: string): Promise<string> => {
  const id = randomUUID();
  extraClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyA, name: `Conteúdo conversa ${label} ${id}` });
  if (portalUser !== undefined) await owner.knex('client_memberships').insert({ client_id: id, user_id: users[portalUser]!.id });
  return id;
};

/**
 * An app over the same database whose statements go through `intercept` first: the test records what reached the database,
 * or turns one statement into the failure real life produces (a deadlock, a refusal by row-level security after the checks).
 */
const withProxiedApp = async <T>(
  intercept: (statement: string) => Promise<void> | void,
  run: (proxied: FastifyInstance) => Promise<T>
): Promise<T> => {
  const proxied = Fastify();
  registerClientModule(proxied, {
    database: {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const wrapped = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return async (statement: string, bindings?: readonly unknown[]) => {
                  await intercept(statement.trim());
                  return target.raw(statement, bindings as never);
                };
              }
              return Reflect.get(target, property, receiver);
            }
          });
          return work(wrapped as typeof transaction);
        })
    } as DatabaseClient,
    auth: app.auth,
    requireAgencyAccess: createRequireAgencyAccess({ database: app.database }),
    requirePermission,
    requireClientAccess: createRequireClientAccess({ database: app.database }),
    photoUrlExpirySeconds: 300
  });
  await proxied.ready();
  try {
    return await run(proxied);
  } finally {
    await proxied.close();
  }
};

const isConversationWrite = (statement: string): boolean => /^(insert into|update) public\.client_thread/i.test(statement);

/** Runs `work` on an app that records what it sent to the database, and returns the writes into the conversation tables. */
const writesSentBy = async (work: (proxied: FastifyInstance) => Promise<void>): Promise<string[]> => {
  const sent: string[] = [];
  await withProxiedApp((statement) => { if (isConversationWrite(statement)) sent.push(statement); }, work);
  return sent;
};

type Holder = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const backendPid = async (transaction: Holder): Promise<number> => {
  const result = await raw<{ rows: Array<{ pid: number }> }>(transaction, 'select pg_catalog.pg_backend_pid() as pid', []);
  return Number(result.rows[0]?.pid);
};

/** Waits until a backend of this database is blocked by the given one, so a race is sequenced by locks and never by a sleep. */
const waitForBackendBlockedBy = async (blockerPid: number): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ pid: number }> }>(owner.knex, `
      select activity.pid
      from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
      limit 1
    `, [blockerPid]);
    if (result.rows[0] !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend ever waited on a lock held by ${blockerPid}.`);
};

/** The route starts while the archive is uncommitted, waits on the client in the trigger, and is answered after it commits. */
const archiveWhileRouteWaits = async (clientId: string, start: () => Promise<Reply>): Promise<Reply> => {
  const holder = await owner.knex.transaction();
  let released = false;
  try {
    const locked = await raw<{ rows: Array<{ id: string }> }>(holder, "update public.clients set status = 'archived', archived_at = now() where id = ?::uuid returning id", [clientId]);
    expect(locked.rows).toHaveLength(1);
    const holderPid = await backendPid(holder);
    const pending = start();
    await waitForBackendBlockedBy(holderPid);
    await holder.commit();
    released = true;
    return await pending;
  } finally {
    if (!released) await holder.rollback();
  }
};

const NO_DATABASE_DETAIL = /A0020|deadlock|40P01|40001|pg_|relation|process|serialize/i;

/** The error of the application, `{ error: { code, message } }`; an app without the error plugin answers the same fields flat. */
const errorOf = (reply: Reply): { code?: string; message?: string } => {
  const body = reply.json();
  return typeof body.error === 'object' && body.error !== null ? body.error : body;
};

const expectArchived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(errorOf(reply)).toMatchObject({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const expectGoneForThePortal = (reply: Reply): void => {
  expect(reply.statusCode).toBe(404);
  expect(errorOf(reply)).toMatchObject({ code: 'NOT_FOUND', message: 'Client not found.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const expectContentNotOpen = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(errorOf(reply).code).toBe('CONTENT_NOT_OPEN');
};

describe('CLIENTES conversation of a content (#259)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['manager', 'Marta Gestora'], ['production', 'Paulo Produção'], ['sales', 'Vera Vendas'],
      ['finance', 'Fábio Financeiro'], ['contentRead', 'Só Lê Conteúdo'], ['contentWrite', 'Só Opera Conteúdo'], ['clientBoth', 'Só Clientes'],
      ['ownerUser', 'Dona da Agência'], ['otherAdmin', 'Admin da Outra'], ['twoAgencies', 'Pessoa Duas Agências'],
      ['portalOne', 'Ana do Portal'], ['portalMulti', 'Bia dos Dois Clientes'], ['portalOther', 'Portal Outro Cliente'],
      ['portalB', 'Portal Outra Agência'], ['dual', 'Pessoa Dupla'], ['dualBare', 'Pessoa Dupla Sem Papel'], ['crossDual', 'Pessoa Dupla Cruzada']
    ] as const) {
      await makeUser(key, name);
    }

    const systemRoles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => {
      const role = systemRoles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Conversa Conteúdo A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Conversa Conteúdo B', owner_user_id: null }
    ]);

    // Custom roles with exactly the permissions named: an admin holds every key and hides a guard on the wrong one.
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };
    const contentReadRole = await customRole('conteudo.visualizar');
    const contentWriteRole = await customRole('conteudo.operar');
    const clientBothRole = await customRole('cliente.visualizar', 'cliente.operar');
    const unrelatedRole = await customRole('midia.enviar');

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.production!.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: users.sales!.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: users.finance!.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: users.contentRead!.id, role_id: contentReadRole },
      { agency_id: agencyA, user_id: users.contentWrite!.id, role_id: contentWriteRole },
      { agency_id: agencyA, user_id: users.clientBoth!.id, role_id: clientBothRole },
      { agency_id: agencyA, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.twoAgencies!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: unrelatedRole },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') }
    ]);

    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Conteúdo A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Conteúdo A2 ${clientA2}` },
      { id: clientB1, agency_id: agencyB, name: `Conteúdo B1 ${clientB1}` },
      { id: clientCounters, agency_id: agencyA, name: `Conteúdo contadores ${clientCounters}` },
      { id: clientArchived, agency_id: agencyA, name: `Conteúdo arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() }
    ]);
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.portalOne!.id },
      { client_id: clientA1, user_id: users.portalMulti!.id },
      { client_id: clientA2, user_id: users.portalMulti!.id },
      { client_id: clientA2, user_id: users.portalOther!.id },
      { client_id: clientB1, user_id: users.portalB!.id },
      { client_id: clientA1, user_id: users.dual!.id },
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.crossDual!.id },
      { client_id: clientCounters, user_id: users.portalOne!.id },
      { client_id: clientArchived, user_id: users.portalOne!.id }
    ]);

    for (const key of Object.keys(users)) {
      const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
      expect(login.statusCode).toBe(200);
      cookies[key] = sessionCookieHeader(login.cookies);
    }
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2, clientB1, clientArchived, clientCounters, ...extraClientIds];
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('id', contentIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  describe('one conversation per content, in the formato of the brand study', () => {
    it('opens it for the agency with the first comment, stamping the agency side and the author by the link', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, 'Pode ver a legenda?');
      expect(opened.statusCode).toBe(201);
      const { thread, comment } = opened.json();
      expect(thread).toMatchObject({
        subject: { contentId },
        state: 'open',
        openedBy: { name: 'Marta Gestora', side: 'agency' },
        lastComment: { side: 'agency', excerpt: 'Pode ver a legenda?' },
        commentCount: 1,
        resolvedBy: null,
        resolvedAt: null
      });
      expect(comment).toMatchObject({ body: 'Pode ver a legenda?', side: 'agency', author: { name: 'Marta Gestora', photoUrl: null } });
      expect(await threadRow(thread.id)).toMatchObject({ client_id: clientA1, content_id: contentId, section_key: null, persona_id: null, opened_by: users.manager!.id, opened_side: 'agency' });
      expect((await commentRows(thread.id)).map((row) => [row.author_side, row.author_user_id])).toEqual([['agency', users.manager!.id]]);
    });

    it('opens it for the portal person with the client side, and the author is read from the client link', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const opened = await openAs(cookies.portalOne!, portalThreads(clientA1), contentId, 'Ficou ótimo!');
      expect(opened.statusCode).toBe(201);
      expect(opened.json().thread).toMatchObject({ subject: { contentId }, openedBy: { name: 'Ana do Portal', side: 'client' }, commentCount: 1 });
      expect(opened.json().comment).toMatchObject({ side: 'client', author: { name: 'Ana do Portal' } });
      expect(await threadRow(opened.json().thread.id)).toMatchObject({ content_id: contentId, opened_by: users.portalOne!.id, opened_side: 'client' });
    });

    it('opens it once: the next opening, from either side, writes into the same conversation', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const first = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, 'Um');
      const second = await openAs(cookies.portalOne!, portalThreads(clientA1), contentId, 'Dois');
      const third = await openAs(cookies.production!, agencyThreads(agencyA, clientA1), contentId, 'Três');
      expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
      const threadId = first.json().thread.id as string;
      expect([second.json().thread.id, third.json().thread.id]).toEqual([threadId, threadId]);
      expect(third.json().thread).toMatchObject({ commentCount: 3, openedBy: { name: 'Marta Gestora', side: 'agency' } });
      expect(await threadsOfContent(contentId)).toHaveLength(1);
      expect((await commentRows(threadId)).map((row) => [row.author_side, row.body])).toEqual([['agency', 'Um'], ['client', 'Dois'], ['agency', 'Três']]);
    });

    it('is a conversation of one content only: another content of the same client has its own', async () => {
      const first = await seedContent(clientA1, 'awaiting_approval');
      const second = await seedContent(clientA1, 'approved');
      const a = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), first, 'Do primeiro');
      const b = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), second, 'Do segundo');
      expect(a.json().thread.id).not.toBe(b.json().thread.id);
      expect((await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), first)).json().data.map((item: { id: string }) => item.id)).toEqual([a.json().thread.id]);
      expect((await listAs(cookies.portalOne!, portalThreads(clientA1), second)).json().data.map((item: { id: string }) => item.id)).toEqual([b.json().thread.id]);
    });

    it('lists the conversation with its total, an empty content with none, and a page past the end with the real total', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const empty = await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId);
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toMatchObject({ data: [], meta: { totalItems: 0 } });

      const opened = await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId);
      const listed = await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId);
      expect(listed.json().data.map((item: { id: string }) => item.id)).toEqual([opened.json().thread.id]);
      expect(listed.json().meta).toMatchObject({ totalItems: 1, page: 1 });
      const beyond = await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, '&page=3&pageSize=1');
      expect(beyond.statusCode).toBe(200);
      expect(beyond.json()).toMatchObject({ data: [], meta: { totalItems: 1, page: 3 } });
      expect((await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, '&state=resolved')).json()).toMatchObject({ data: [], meta: { totalItems: 0 } });
      expect((await listAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, '&state=open')).json().meta.totalItems).toBe(1);
    });

    it('lists the comments of the conversation, oldest first, with the author of each side by the link', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [
        { author: 'manager', side: 'agency', body: 'Primeiro', at: '2026-10-01T10:00:00Z' },
        { author: 'portalOne', side: 'client', body: 'Segundo', at: '2026-10-01T11:00:00Z' }
      ]);
      for (const [cookie, url] of [[cookies.manager!, agencyThreads(agencyA, clientA1)], [cookies.portalOne!, portalThreads(clientA1)]] as const) {
        const comments = await commentsAs(cookie, url, threadId);
        expect(comments.statusCode).toBe(200);
        expect(comments.json().data.map((item: { body: string; side: string; author: { name: string } }) => [item.body, item.side, item.author.name]))
          .toEqual([['Primeiro', 'agency', 'Marta Gestora'], ['Segundo', 'client', 'Ana do Portal']]);
        expect(comments.json().meta.totalItems).toBe(2);
      }
    });

    it('reopens it when the portal comments after the agency resolved it, and not when the agency comments', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = (await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId)).json().thread.id as string;
      const resolved = await resolveAs(cookies.manager!, agencyThreads(agencyA, clientA1), threadId);
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedBy: { name: 'Marta Gestora' }, subject: { contentId } });

      await commentAs(cookies.production!, agencyThreads(agencyA, clientA1), threadId, 'Só a agência de novo.');
      // The row keeps its resolution: only a comment of the client clears it (the trigger of #212).
      expect(await threadRow(threadId)).toMatchObject({ resolved_by: users.manager!.id });
      expect((await threadRow(threadId))?.resolved_at).not.toBeNull();

      await commentAs(cookies.portalOne!, portalThreads(clientA1), threadId, 'Tenho uma dúvida.');
      expect((await listAs(cookies.portalOne!, portalThreads(clientA1), contentId)).json().data[0]).toMatchObject({ state: 'open', lastComment: { side: 'client' }, commentCount: 3 });
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null, resolved_by: null });
    });

    it('has no resolve on the portal', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = (await openAs(cookies.portalOne!, portalThreads(clientA1), contentId)).json().thread.id as string;
      expect((await call('POST', `${portalThreads(clientA1)}/${threadId}/resolve`, cookies.portalOne!, {})).statusCode).toBe(404);
      expect(await threadRow(threadId)).toMatchObject({ resolved_at: null });
    });

    it('answers 401 to a caller without a session, on every route', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      for (const [method, url, payload] of [
        ['GET', `${agencyThreads(agencyA, clientA1)}?contentId=${contentId}`, undefined],
        ['POST', agencyThreads(agencyA, clientA1), { subject: { contentId }, body: 'x' }],
        ['POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/comments`, { body: 'x' }],
        ['POST', `${agencyThreads(agencyA, clientA1)}/${threadId}/resolve`, {}],
        ['GET', `${portalThreads(clientA1)}?contentId=${contentId}`, undefined],
        ['POST', portalThreads(clientA1), { subject: { contentId }, body: 'x' }],
        ['POST', `${portalThreads(clientA1)}/${threadId}/comments`, { body: 'x' }]
      ] as const) {
        const reply = (await app.app.inject({ method, url, headers: origin, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })) as unknown as Reply;
        expect(reply.statusCode, `${method} ${url}`).toBe(401);
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
    });
  });

  describe('the agency: conteudo.operar writes and conteudo.visualizar reads, never the permissions of Clientes', () => {
    const base = (): string => agencyThreads(agencyA, clientA1);

    const seedThreadOfSection = async (): Promise<string> => {
      const id = randomUUID();
      await owner.knex('client_threads').insert({ id, client_id: clientA1, section_key: 'observations', opened_by: users.portalOne!.id, opened_side: 'client' });
      await owner.knex('client_thread_comments').insert({ thread_id: id, client_id: clientA1, author_user_id: users.portalOne!.id, author_side: 'client', body: 'Sugestão' });
      return id;
    };

    it('lets a Produção person, who has no cliente.operar, open, comment and resolve; the same person is refused on the brand study', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const opened = await openAs(cookies.production!, base(), contentId, 'Da produção');
      expect(opened.statusCode).toBe(201);
      const threadId = opened.json().thread.id as string;
      expect((await commentAs(cookies.production!, base(), threadId)).statusCode).toBe(201);
      expect((await resolveAs(cookies.production!, base(), threadId)).statusCode).toBe(200);

      const section = await call('POST', base(), cookies.production!, { subject: { sectionKey: 'branding' }, body: 'x' });
      expect(section.statusCode).toBe(403);
      const sectionThread = await seedThreadOfSection();
      expect((await commentAs(cookies.production!, base(), sectionThread)).statusCode).toBe(403);
      expect((await resolveAs(cookies.production!, base(), sectionThread)).statusCode).toBe(403);
    });

    it('lets the Owner, who has no membership row, do everything, and names nobody for the author', async () => {
      const contentId = await seedContent(clientA1, 'approved');
      const opened = await openAs(cookies.ownerUser!, base(), contentId, 'Do dono');
      expect(opened.statusCode).toBe(201);
      expect(opened.json().comment.author).toBeNull();
      expect((await resolveAs(cookies.ownerUser!, base(), opened.json().thread.id)).statusCode).toBe(200);
    });

    it('with conteudo.visualizar alone reads the conversation and writes nothing, and nothing reaches the conversation tables', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      expect((await listAs(cookies.contentRead!, base(), contentId)).statusCode).toBe(200);
      expect((await commentsAs(cookies.contentRead!, base(), threadId)).statusCode).toBe(200);

      const sent = await writesSentBy(async (proxied) => {
        expect((await openAs(cookies.contentRead!, base(), contentId, 'x', proxied)).statusCode).toBe(403);
        expect((await commentAs(cookies.contentRead!, base(), threadId, 'x', proxied)).statusCode).toBe(403);
        expect((await resolveAs(cookies.contentRead!, base(), threadId, proxied)).statusCode).toBe(403);
      });
      expect(sent).toEqual([]);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('with conteudo.operar alone writes nothing, because a write needs the read: the thread is not found and a new one is refused', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const free = await seedContent(clientA1, 'awaiting_approval');
      const before = await snapshotOf(clientA1);
      const sent = await writesSentBy(async (proxied) => {
        expect((await openAs(cookies.contentWrite!, base(), free, 'x', proxied)).statusCode).toBe(403);
        expect((await commentAs(cookies.contentWrite!, base(), threadId, 'x', proxied)).statusCode).toBe(404);
        expect((await resolveAs(cookies.contentWrite!, base(), threadId, proxied)).statusCode).toBe(404);
      });
      expect(sent).toEqual([]);
      expect((await listAs(cookies.contentWrite!, base(), contentId)).statusCode).toBe(403);
      expect((await commentsAs(cookies.contentWrite!, base(), threadId)).statusCode).toBe(403);
      expect(await snapshotOf(clientA1)).toEqual(before);
      expect(await threadsOfContent(free)).toHaveLength(0);
    });

    it('with every cliente permission and no conteudo one neither reads nor writes the conversation of a content', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      const sent = await writesSentBy(async (proxied) => {
        expect((await openAs(cookies.clientBoth!, base(), contentId, 'x', proxied)).statusCode).toBe(403);
        expect((await commentAs(cookies.clientBoth!, base(), threadId, 'x', proxied)).statusCode).toBe(404);
        expect((await resolveAs(cookies.clientBoth!, base(), threadId, proxied)).statusCode).toBe(404);
      });
      expect(sent).toEqual([]);
      expect((await listAs(cookies.clientBoth!, base(), contentId)).statusCode).toBe(403);
      expect((await commentsAs(cookies.clientBoth!, base(), threadId)).statusCode).toBe(404);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('keeps Sales and Finance, who do not see Conteúdo, out of every route of the conversation', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      for (const key of ['sales', 'finance']) {
        expect((await listAs(cookies[key]!, base(), contentId)).statusCode, `${key} list`).toBe(403);
        expect((await commentsAs(cookies[key]!, base(), threadId)).statusCode, `${key} comments`).toBe(404);
        expect((await openAs(cookies[key]!, base(), contentId)).statusCode, `${key} open`).toBe(403);
        expect((await commentAs(cookies[key]!, base(), threadId)).statusCode, `${key} comment`).toBe(403);
        expect((await resolveAs(cookies[key]!, base(), threadId)).statusCode, `${key} resolve`).toBe(403);
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('holds the brand study to the permissions of Clientes: conteudo.* alone does not open, comment, resolve or list a section', async () => {
      const sectionThread = await seedThreadOfSection();
      const before = await snapshotOf(clientA1);
      for (const key of ['contentRead', 'contentWrite']) {
        expect((await call('GET', `${base()}?sectionKey=observations`, cookies[key]!)).statusCode, `${key} list`).toBe(403);
        expect((await call('POST', base(), cookies[key]!, { subject: { sectionKey: 'observations' }, body: 'x' })).statusCode, `${key} open`).toBe(403);
        expect((await commentAs(cookies[key]!, base(), sectionThread)).statusCode, `${key} comment`).toBe(403);
        expect((await resolveAs(cookies[key]!, base(), sectionThread)).statusCode, `${key} resolve`).toBe(403);
        expect((await commentsAs(cookies[key]!, base(), sectionThread)).statusCode, `${key} comments`).toBe(403);
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('opens, comments and lists in the four states open to the client', async () => {
      for (const status of OPEN_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const opened = await openAs(cookies.manager!, base(), contentId, `Em ${status}`);
        expect(opened.statusCode, status).toBe(201);
        expect((await commentAs(cookies.manager!, base(), opened.json().thread.id)).statusCode, status).toBe(201);
        expect((await listAs(cookies.manager!, base(), contentId)).json().meta.totalItems, status).toBe(1);
      }
    });

    it('refuses to open or comment while the content is in production or cancelled, with 409, and writes nothing', async () => {
      for (const status of CLOSED_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const before = await snapshotOf(clientA1);
        const sent = await writesSentBy(async (proxied) => {
          const refused = await openAs(cookies.manager!, base(), contentId, 'Cedo demais', proxied);
          expectContentNotOpen(refused);
          expect(errorOf(refused).message).toBe('A conversa do conteúdo só existe a partir de "aguardando aprovação".');
        });
        expect(sent, status).toEqual([]);
        expect(await snapshotOf(clientA1), status).toEqual(before);
        expect(await threadsOfContent(contentId)).toHaveLength(0);
      }
    });

    it('refuses to comment on a conversation whose content went back to production or was cancelled, and still reads and resolves it', async () => {
      for (const status of ['in_production', 'cancelled'] as const) {
        const contentId = await seedContent(clientA1, status);
        const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
        const commentsBefore = (await commentRows(threadId)).length;
        const sent = await writesSentBy(async (proxied) => {
          expectContentNotOpen(await commentAs(cookies.manager!, base(), threadId, 'Tarde demais', proxied));
        });
        expect(sent, status).toEqual([]);
        expect(await commentRows(threadId), status).toHaveLength(commentsBefore);
        expect((await listAs(cookies.manager!, base(), contentId)).json().data.map((item: { id: string }) => item.id), status).toEqual([threadId]);
        expect((await commentsAs(cookies.manager!, base(), threadId)).json().meta.totalItems, status).toBe(1);
        expect((await resolveAs(cookies.manager!, base(), threadId)).statusCode, status).toBe(200);
      }
    });

    it('reads the conversation of a content that is not open yet, which is empty: reading never writes', async () => {
      for (const status of CLOSED_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const listed = await listAs(cookies.manager!, base(), contentId);
        expect(listed.statusCode, status).toBe(200);
        expect(listed.json().meta.totalItems, status).toBe(0);
      }
    });

    it('answers 404 to a content of another client of the same agency, on open and on list, and writes nothing', async () => {
      const ofA2 = await seedContent(clientA2, 'awaiting_approval');
      const before = await snapshotOf(clientA1);
      const beforeA2 = await snapshotOf(clientA2);
      expect((await openAs(cookies.manager!, base(), ofA2)).statusCode).toBe(404);
      expect((await listAs(cookies.manager!, base(), ofA2)).statusCode).toBe(404);
      expect(await snapshotOf(clientA1)).toEqual(before);
      expect(await snapshotOf(clientA2)).toEqual(beforeA2);
      expect(await threadsOfContent(ofA2)).toHaveLength(0);
      // The same content through its own client works, so the 404 above is about the client in the path.
      expect((await openAs(cookies.manager!, agencyThreads(agencyA, clientA2), ofA2)).statusCode).toBe(201);
    });

    it('answers 404 to a content of another agency, and to a client of another agency, for a person who belongs to both', async () => {
      const ofB1 = await seedContent(clientB1, 'awaiting_approval');
      const ofA1 = await seedContent(clientA1, 'awaiting_approval');
      const before = await snapshotOf(clientA1);
      const beforeB = await snapshotOf(clientB1);
      for (const key of ['manager', 'twoAgencies']) {
        expect((await openAs(cookies[key]!, base(), ofB1)).statusCode, `${key} B content on A client`).toBe(404);
        expect((await listAs(cookies[key]!, base(), ofB1)).statusCode, `${key} list B content`).toBe(404);
      }
      expect((await openAs(cookies.twoAgencies!, agencyThreads(agencyB, clientB1), ofA1)).statusCode).toBe(404);
      expect((await openAs(cookies.twoAgencies!, agencyThreads(agencyB, clientA1), ofA1)).statusCode).toBe(404);
      expect((await openAs(cookies.twoAgencies!, agencyThreads(agencyA, clientB1), ofB1)).statusCode).toBe(404);
      expect((await openAs(cookies.otherAdmin!, agencyThreads(agencyB, clientA1), ofA1)).statusCode).toBe(404);
      expect((await openAs(cookies.otherAdmin!, base(), ofA1)).statusCode).toBe(404);
      expect(await snapshotOf(clientA1)).toEqual(before);
      expect(await snapshotOf(clientB1)).toEqual(beforeB);
      expect(await threadsOfContent(ofB1)).toHaveLength(0);
      expect(await threadsOfContent(ofA1)).toHaveLength(0);
    });

    it('answers 404 to a conversation of another content of another client in the path, on comments, reads and resolve', async () => {
      const ofA2 = await seedContent(clientA2, 'awaiting_approval');
      const threadOfA2 = await seedContentThread(clientA2, ofA2, [{ author: 'portalOther', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA2);
      expect((await commentAs(cookies.manager!, base(), threadOfA2)).statusCode).toBe(404);
      expect((await commentsAs(cookies.manager!, base(), threadOfA2)).statusCode).toBe(404);
      expect((await resolveAs(cookies.manager!, base(), threadOfA2)).statusCode).toBe(404);
      expect((await commentAs(cookies.otherAdmin!, agencyThreads(agencyB, clientB1), threadOfA2)).statusCode).toBe(404);
      expect(await snapshotOf(clientA2)).toEqual(before);
      expect((await commentsAs(cookies.manager!, agencyThreads(agencyA, clientA2), threadOfA2)).statusCode).toBe(200);
    });

    it('answers 404 to a content that does not exist, and 400 to one that is not a uuid', async () => {
      const before = await snapshotOf(clientA1);
      expect((await openAs(cookies.manager!, base(), randomUUID())).statusCode).toBe(404);
      expect((await listAs(cookies.manager!, base(), randomUUID())).statusCode).toBe(404);
      expect((await call('POST', base(), cookies.manager!, { subject: { contentId: 'not-a-uuid' }, body: 'x' })).statusCode).toBe(400);
      expect((await call('GET', `${base()}?contentId=not-a-uuid`, cookies.manager!)).statusCode).toBe(400);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('answers 409 CLIENT_ARCHIVED to a write on an archived client, and still reads its conversation', async () => {
      const contentId = await seedContent(clientArchived, 'approved');
      const threadId = await seedContentThread(clientArchived, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientArchived);
      const url = agencyThreads(agencyA, clientArchived);
      expectArchived(await openAs(cookies.manager!, url, contentId));
      expectArchived(await commentAs(cookies.manager!, url, threadId));
      expectArchived(await resolveAs(cookies.manager!, url, threadId));
      expect(await snapshotOf(clientArchived)).toEqual(before);
      expect((await listAs(cookies.manager!, url, contentId)).json().data.map((item: { id: string }) => item.id)).toEqual([threadId]);
      expect((await commentsAs(cookies.manager!, url, threadId)).statusCode).toBe(200);
    });

    it('names exactly one subject on a listing, and refuses a body with two', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const personaId = randomUUID();
      const before = await snapshotOf(clientA1);
      for (const query of ['', `?contentId=${contentId}&sectionKey=branding`, `?contentId=${contentId}&personaId=${personaId}`, `?contentId=${contentId}&sectionKey=branding&personaId=${personaId}`, `?contentId=${contentId}&unknown=1`]) {
        expect((await call('GET', `${base()}${query}`, cookies.manager!)).statusCode, query).toBe(400);
      }
      expect((await call('POST', base(), cookies.manager!, { subject: { contentId, sectionKey: 'branding' }, body: 'x' })).statusCode).toBe(400);
      expect((await call('POST', base(), cookies.manager!, { subject: { contentId, personaId }, body: 'x' })).statusCode).toBe(400);
      expect((await call('POST', base(), cookies.manager!, { subject: { contentId }, body: 'x', side: 'client' })).statusCode).toBe(400);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });
  });

  describe('the portal: only while the content is open to the client', () => {
    const base = (): string => portalThreads(clientA1);

    it('opens, comments and lists in the four states open to the client', async () => {
      for (const status of OPEN_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const opened = await openAs(cookies.portalOne!, base(), contentId, `Em ${status}`);
        expect(opened.statusCode, status).toBe(201);
        expect(opened.json().comment.side, status).toBe('client');
        expect((await commentAs(cookies.portalOne!, base(), opened.json().thread.id)).statusCode, status).toBe(201);
        expect((await listAs(cookies.portalOne!, base(), contentId)).json().meta.totalItems, status).toBe(1);
        expect((await commentsAs(cookies.portalOne!, base(), opened.json().thread.id)).json().meta.totalItems, status).toBe(2);
      }
    });

    it('answers 404 to every route while the content is in production or cancelled, even for a conversation that already exists', async () => {
      for (const status of CLOSED_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
        const free = await seedContent(clientA1, status);
        const before = await snapshotOf(clientA1);
        const sent = await writesSentBy(async (proxied) => {
          expect((await openAs(cookies.portalOne!, base(), free, 'x', proxied)).statusCode, `${status} open`).toBe(404);
          expect((await commentAs(cookies.portalOne!, base(), threadId, 'x', proxied)).statusCode, `${status} comment`).toBe(404);
        });
        expect(sent, status).toEqual([]);
        expect((await listAs(cookies.portalOne!, base(), contentId)).statusCode, `${status} list`).toBe(404);
        expect((await listAs(cookies.portalOne!, base(), free)).statusCode, `${status} list free`).toBe(404);
        expect((await commentsAs(cookies.portalOne!, base(), threadId)).statusCode, `${status} comments`).toBe(404);
        expect(await snapshotOf(clientA1), status).toEqual(before);
      }
    });

    it('comes back when the content is sent again: the conversation was kept', async () => {
      const contentId = await seedContent(clientA1, 'in_production');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      expect((await commentsAs(cookies.portalOne!, base(), threadId)).statusCode).toBe(404);
      await moveContent(contentId, 'awaiting_approval');
      expect((await commentsAs(cookies.portalOne!, base(), threadId)).statusCode).toBe(200);
      expect((await commentAs(cookies.portalOne!, base(), threadId)).statusCode).toBe(201);
    });

    it('answers 404 to a content of another client, even one of a client the same person is linked to', async () => {
      const ofA2 = await seedContent(clientA2, 'awaiting_approval');
      const ofB1 = await seedContent(clientB1, 'awaiting_approval');
      const threadOfA2 = await seedContentThread(clientA2, ofA2, [{ author: 'portalOther', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      const beforeA2 = await snapshotOf(clientA2);
      const sent = await writesSentBy(async (proxied) => {
        for (const key of ['portalOne', 'portalMulti']) {
          expect((await openAs(cookies[key]!, base(), ofA2, 'x', proxied)).statusCode, `${key} open A2 content`).toBe(404);
          expect((await commentAs(cookies[key]!, base(), threadOfA2, 'x', proxied)).statusCode, `${key} comment A2 thread`).toBe(404);
        }
        expect((await openAs(cookies.portalMulti!, base(), ofB1, 'x', proxied)).statusCode).toBe(404);
      });
      expect(sent).toEqual([]);
      for (const key of ['portalOne', 'portalMulti']) {
        expect((await listAs(cookies[key]!, base(), ofA2)).statusCode, `${key} list A2 content`).toBe(404);
        expect((await commentsAs(cookies[key]!, base(), threadOfA2)).statusCode, `${key} comments A2 thread`).toBe(404);
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
      expect(await snapshotOf(clientA2)).toEqual(beforeA2);
      expect((await openAs(cookies.portalMulti!, portalThreads(clientA2), ofA2)).statusCode).toBe(201);
    });

    it('answers 404 to a person with no link to the client, and to the client of another agency', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const before = await snapshotOf(clientA1);
      expect((await openAs(cookies.portalOther!, base(), contentId)).statusCode).toBe(404);
      expect((await listAs(cookies.portalOther!, base(), contentId)).statusCode).toBe(404);
      expect((await openAs(cookies.portalB!, base(), contentId)).statusCode).toBe(404);
      expect((await openAs(cookies.crossDual!, portalThreads(clientA2), contentId)).statusCode).toBe(404);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('answers 404 to a content that does not exist, and 400 to one that is not a uuid', async () => {
      const before = await snapshotOf(clientA1);
      expect((await openAs(cookies.portalOne!, base(), randomUUID())).statusCode).toBe(404);
      expect((await listAs(cookies.portalOne!, base(), randomUUID())).statusCode).toBe(404);
      expect((await call('POST', base(), cookies.portalOne!, { subject: { contentId: 'x' }, body: 'x' })).statusCode).toBe(400);
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('answers 404 on every route for an archived client, whatever state its content is in', async () => {
      const contentId = await seedContent(clientArchived, 'approved');
      const threadId = await seedContentThread(clientArchived, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientArchived);
      const url = portalThreads(clientArchived);
      expect((await listAs(cookies.portalOne!, url, contentId)).statusCode).toBe(404);
      expect((await openAs(cookies.portalOne!, url, contentId)).statusCode).toBe(404);
      expect((await commentsAs(cookies.portalOne!, url, threadId)).statusCode).toBe(404);
      expect((await commentAs(cookies.portalOne!, url, threadId)).statusCode).toBe(404);
      expect(await snapshotOf(clientArchived)).toEqual(before);
    });

    // A person who is a collaborator AND has a client link crosses row-level security through its agency branch, so the
    // rule "the portal sees the conversation only while the content is open to the client" has to hold by the route's own SQL.
    it('shows a collaborator who also has a client link nothing the plain portal person does not see, with the content in production', async () => {
      for (const status of CLOSED_STATUSES) {
        const contentId = await seedContent(clientA1, status);
        const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
        const free = await seedContent(clientA1, status);
        const before = await snapshotOf(clientA1);
        for (const key of ['dual', 'dualBare', 'crossDual', 'portalOne']) {
          const cookie = cookies[key]!;
          expect([
            (await listAs(cookie, base(), contentId)).statusCode,
            (await listAs(cookie, base(), free)).statusCode,
            (await commentsAs(cookie, base(), threadId)).statusCode,
            (await commentAs(cookie, base(), threadId)).statusCode,
            (await openAs(cookie, base(), free)).statusCode
          ], `${key} ${status}`).toEqual([404, 404, 404, 404, 404]);
        }
        expect(await snapshotOf(clientA1), status).toEqual(before);
        // The same collaborator, through the agency routes, is still the agency: it reads what the portal does not.
        const read = await commentsAs(cookies.dual!, agencyThreads(agencyA, clientA1), threadId);
        expect(read.statusCode, status).toBe(200);
      }
    });

    it('answers a collaborator with a client link exactly what it answers a plain portal person, with the content open', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [
        { author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' },
        { author: 'portalOne', side: 'client', at: '2026-10-01T11:00:00Z' }
      ]);
      for (const url of [`${base()}?contentId=${contentId}&pageSize=100`, `${base()}/${threadId}/comments`]) {
        const plain = await call('GET', url, cookies.portalOne!);
        expect(plain.statusCode).toBe(200);
        for (const key of ['dual', 'dualBare', 'crossDual']) {
          const crossing = await call('GET', url, cookies[key]!);
          expect(crossing.statusCode, `${key} ${url}`).toBe(200);
          expect(crossing.json(), `${key} ${url}`).toEqual(plain.json());
        }
      }
    });

    it('stamps the client side on a collaborator who writes through the portal, whatever the agency role', async () => {
      for (const key of ['dual', 'dualBare', 'crossDual']) {
        const contentId = await seedContent(clientA1, 'awaiting_approval');
        const opened = await openAs(cookies[key]!, base(), contentId, `Como cliente, ${key}`);
        expect(opened.statusCode, key).toBe(201);
        expect(opened.json().comment.side, key).toBe('client');
        expect(await threadRow(opened.json().thread.id)).toMatchObject({ opened_side: 'client', opened_by: users[key]!.id });
        const commented = await commentAs(cookies[key]!, base(), opened.json().thread.id);
        expect(commented.json().side, key).toBe('client');
        expect((await commentRows(opened.json().thread.id)).map((row) => row.author_side), key).toEqual(['client', 'client']);
      }
      // And through the agency routes, the same person with the role of the agency writes as the agency, only with its permissions.
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      expect((await openAs(cookies.dual!, agencyThreads(agencyA, clientA1), contentId)).json().comment.side).toBe('agency');
      expect((await openAs(cookies.dualBare!, agencyThreads(agencyA, clientA1), contentId)).statusCode).toBe(403);
      expect((await openAs(cookies.crossDual!, agencyThreads(agencyA, clientA1), contentId)).statusCode).toBe(404);
    });

    it('answers 404 on every portal route once the link of a collaborator who also has one is removed, while the agency routes stay open', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      expect((await commentsAs(cookies.dual!, base(), threadId)).statusCode).toBe(200);
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.dual!.id }).update({ status: 'removed' });
      try {
        const before = await snapshotOf(clientA1);
        expect([
          (await listAs(cookies.dual!, base(), contentId)).statusCode,
          (await commentsAs(cookies.dual!, base(), threadId)).statusCode,
          (await commentAs(cookies.dual!, base(), threadId)).statusCode,
          (await openAs(cookies.dual!, base(), contentId)).statusCode
        ]).toEqual([404, 404, 404, 404]);
        expect(await snapshotOf(clientA1)).toEqual(before);
        expect((await commentsAs(cookies.dual!, agencyThreads(agencyA, clientA1), threadId)).statusCode).toBe(200);
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.dual!.id }).update({ status: 'active' });
      }
    });

    it('refuses a side in the body and the invisible texts, on the four routes that take a comment', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      expect((await call('POST', base(), cookies.portalOne!, { subject: { contentId }, body: 'x', side: 'agency' })).statusCode).toBe(400);
      for (const body of [text(0x034f), `a${text(0x034f)}b`, text(0x2800), `a${text(0xfe0e)}b`, text(0x1d159), text(0x200b, 0x200d), `a${text(0x0085)}b`, `a${text(0)}b`]) {
        const label = JSON.stringify(body);
        expect((await openAs(cookies.portalOne!, base(), contentId, body)).statusCode, `portal open ${label}`).toBe(400);
        expect((await commentAs(cookies.portalOne!, base(), threadId, body)).statusCode, `portal comment ${label}`).toBe(400);
        expect((await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, body)).statusCode, `agency open ${label}`).toBe(400);
        expect((await commentAs(cookies.manager!, agencyThreads(agencyA, clientA1), threadId, body)).statusCode, `agency comment ${label}`).toBe(400);
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
      for (const [cookie, url] of [[cookies.portalOne!, base()], [cookies.manager!, agencyThreads(agencyA, clientA1)]] as const) {
        expect((await commentAs(cookie, url, threadId, `Gostei ${text(0x2764, 0xfe0f)} ${text(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}`)).statusCode).toBe(201);
      }
    });
  });

  describe('the counters of Clientes count the brand study only', () => {
    it('leaves the conversation of a content out of the card, the summary, the listing order and the portal home', async () => {
      const waiting = await seedContent(clientCounters, 'awaiting_approval');
      const answered = await seedContent(clientCounters, 'approved');
      await seedContentThread(clientCounters, waiting, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      await seedContentThread(clientCounters, answered, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }, { author: 'manager', side: 'agency', at: '2026-10-01T11:00:00Z' }]);

      const counters = async (): Promise<number[]> => {
        const detail = await call('GET', `/agencies/${agencyA}/clients/${clientCounters}`, cookies.manager!);
        const listing = await call('GET', `/agencies/${agencyA}/clients?search=${encodeURIComponent(`Conteúdo contadores ${clientCounters}`)}`, cookies.manager!);
        const home = await call('GET', `/clients/${clientCounters}`, cookies.portalOne!);
        expect([detail.statusCode, listing.statusCode, home.statusCode]).toEqual([200, 200, 200]);
        return [
          detail.json().summary.threadsAwaitingAgency,
          detail.json().summary.threadsAnsweredByAgency,
          listing.json().data[0].threadsAwaitingAgency,
          home.json().home.threadsAnsweredByAgency
        ];
      };
      expect(await counters()).toEqual([0, 0, 0, 0]);

      // A brand study suggestion of the same client counts, so the zeros above are the filter and not an empty client.
      const section = randomUUID();
      await owner.knex('client_threads').insert({ id: section, client_id: clientCounters, section_key: 'observations', opened_by: users.portalOne!.id, opened_side: 'client' });
      await owner.knex('client_thread_comments').insert({ thread_id: section, client_id: clientCounters, author_user_id: users.portalOne!.id, author_side: 'client', body: 'Sugestão' });
      expect(await counters()).toEqual([1, 0, 1, 0]);
      await owner.knex('client_thread_comments').insert({ thread_id: section, client_id: clientCounters, author_user_id: users.manager!.id, author_side: 'agency', body: 'Resposta', created_at: new Date(Date.now() + 60_000) });
      expect(await counters()).toEqual([0, 1, 0, 1]);
    });
  });

  describe('a conversation never turns into a 500', () => {
    it('answers 409 TRY_AGAIN to a deadlock or a serialization failure on any of the four writes, and writes nothing', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const free = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
      const before = await snapshotOf(clientA1);
      for (const [code, message] of [['40P01', 'deadlock detected'], ['40001', 'could not serialize access']] as const) {
        await withProxiedApp((statement) => {
          if (isConversationWrite(statement)) throw Object.assign(new Error(message), { code });
        }, async (proxied) => {
          const replies = {
            'agency open': await openAs(cookies.manager!, agencyThreads(agencyA, clientA1), free, 'x', proxied),
            'portal open': await openAs(cookies.portalOne!, portalThreads(clientA1), free, 'x', proxied),
            'agency comment': await commentAs(cookies.manager!, agencyThreads(agencyA, clientA1), threadId, 'x', proxied),
            'portal comment': await commentAs(cookies.portalOne!, portalThreads(clientA1), threadId, 'x', proxied),
            'agency resolve': await resolveAs(cookies.manager!, agencyThreads(agencyA, clientA1), threadId, proxied)
          };
          for (const [name, reply] of Object.entries(replies)) {
            expect(reply.statusCode, `${code} ${name}`).toBe(409);
            expect(errorOf(reply).code, `${code} ${name}`).toBe('TRY_AGAIN');
            expect(JSON.stringify(reply.json()), `${code} ${name}`).not.toMatch(NO_DATABASE_DETAIL);
          }
        });
      }
      expect(await snapshotOf(clientA1)).toEqual(before);
    });

    it('answers what the row-level security refusal means once the content closes between the check and the write: 409 on the agency, 404 on the portal', async () => {
      for (const side of ['agency', 'portal'] as const) {
        const contentId = await seedContent(clientA1, 'awaiting_approval');
        const threadId = await seedContentThread(clientA1, contentId, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);
        const free = await seedContent(clientA1, 'awaiting_approval');
        const before = await snapshotOf(clientA1);
        let armed = true;
        await withProxiedApp(async (statement) => {
          if (!armed || !isConversationWrite(statement)) return;
          armed = false;
          await moveContent(side === 'agency' ? free : contentId, 'cancelled');
          throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
        }, async (proxied) => {
          const url = side === 'agency' ? agencyThreads(agencyA, clientA1) : portalThreads(clientA1);
          const cookie = side === 'agency' ? cookies.manager! : cookies.portalOne!;
          const reply = side === 'agency' ? await openAs(cookie, url, free, 'x', proxied) : await commentAs(cookie, url, threadId, 'x', proxied);
          if (side === 'agency') expectContentNotOpen(reply);
          else {
            expect(reply.statusCode).toBe(404);
            expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
          }
        });
        expect(await snapshotOf(clientA1), side).toEqual(before);
      }
    });

    it('answers 409 CONTENT_NOT_OPEN to a comment of the agency on an existing conversation whose content closes between the check and the write', async () => {
      const contentId = await seedContent(clientA1, 'awaiting_approval');
      const threadId = await seedContentThread(clientA1, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      let armed = true;
      await withProxiedApp(async (statement) => {
        if (!armed || !isConversationWrite(statement)) return;
        armed = false;
        await moveContent(contentId, 'cancelled');
        throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
      }, async (proxied) => {
        expectContentNotOpen(await commentAs(cookies.manager!, agencyThreads(agencyA, clientA1), threadId, 'x', proxied));
      });
      expect(await commentRows(threadId)).toHaveLength(1);
    });

    it('answers 409 CLIENT_ARCHIVED to the agency, and 404 to the portal, when the archive commits between the check and the write', async () => {
      for (const side of ['agency', 'portal'] as const) {
        const clientId = await newClient(`janela-${side}`, 'portalOne');
        const contentId = await seedContent(clientId, 'awaiting_approval');
        let armed = true;
        await withProxiedApp(async (statement) => {
          if (!armed || !isConversationWrite(statement)) return;
          armed = false;
          await owner.knex('clients').where({ id: clientId }).update({ status: 'archived', archived_at: new Date() });
          throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
        }, async (proxied) => {
          const reply = side === 'agency'
            ? await openAs(cookies.manager!, agencyThreads(agencyA, clientId), contentId, 'x', proxied)
            : await openAs(cookies.portalOne!, portalThreads(clientId), contentId, 'x', proxied);
          if (side === 'agency') expectArchived(reply);
          else expectGoneForThePortal(reply);
        });
        expect(await countThreads(clientId), side).toBe(0);
        expect(await countComments(clientId), side).toBe(0);
      }
    });

    it('answers 409 CLIENT_ARCHIVED, and 404 to the portal, when the archive is still running while the write waits on the client, and writes nothing', async () => {
      const agencyOpen = await newClient('trava-abrir-agencia', 'portalOne');
      const portalOpen = await newClient('trava-abrir-portal', 'portalOne');
      const agencyComment = await newClient('trava-comentar-agencia', 'portalOne');
      const portalComment = await newClient('trava-comentar-portal', 'portalOne');
      const contents = {
        agencyOpen: await seedContent(agencyOpen, 'awaiting_approval'),
        portalOpen: await seedContent(portalOpen, 'awaiting_approval'),
        agencyComment: await seedContent(agencyComment, 'awaiting_approval'),
        portalComment: await seedContent(portalComment, 'awaiting_approval')
      };
      const threadOfAgencyComment = await seedContentThread(agencyComment, contents.agencyComment, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      const threadOfPortalComment = await seedContentThread(portalComment, contents.portalComment, [{ author: 'manager', side: 'agency', at: '2026-10-01T10:00:00Z' }]);

      expectArchived(await archiveWhileRouteWaits(agencyOpen, () => openAs(cookies.manager!, agencyThreads(agencyA, agencyOpen), contents.agencyOpen)));
      expect(await countThreads(agencyOpen)).toBe(0);
      expect(await countComments(agencyOpen)).toBe(0);

      expectGoneForThePortal(await archiveWhileRouteWaits(portalOpen, () => openAs(cookies.portalOne!, portalThreads(portalOpen), contents.portalOpen)));
      expect(await countThreads(portalOpen)).toBe(0);
      expect(await countComments(portalOpen)).toBe(0);

      expectArchived(await archiveWhileRouteWaits(agencyComment, () => commentAs(cookies.manager!, agencyThreads(agencyA, agencyComment), threadOfAgencyComment)));
      expect(await commentRows(threadOfAgencyComment)).toHaveLength(1);

      expectGoneForThePortal(await archiveWhileRouteWaits(portalComment, () => commentAs(cookies.portalOne!, portalThreads(portalComment), threadOfPortalComment)));
      expect(await commentRows(threadOfPortalComment)).toHaveLength(1);
    }, 60_000);

    it('answers 409 CLIENT_ARCHIVED when the archive runs while the second opening of a conversation waits, and keeps the first comment', async () => {
      const clientId = await newClient('trava-segunda-abertura', 'portalOne');
      const contentId = await seedContent(clientId, 'awaiting_approval');
      const threadId = await seedContentThread(clientId, contentId, [{ author: 'portalOne', side: 'client', at: '2026-10-01T10:00:00Z' }]);
      expectArchived(await archiveWhileRouteWaits(clientId, () => openAs(cookies.manager!, agencyThreads(agencyA, clientId), contentId, 'Segunda')));
      expect(await commentRows(threadId)).toHaveLength(1);
      expect(await threadsOfContent(contentId)).toHaveLength(1);
    }, 30_000);
  });

  describe('two first comments never make two conversations', () => {
    it('writes the second into the conversation the first is still creating, as the agency and as the portal, and fails neither', async () => {
      for (const [first, second] of [['manager', 'portalOne'], ['portalOne', 'manager'], ['manager', 'production'], ['portalOne', 'portalMulti']] as const) {
        const contentId = await seedContent(clientA1, 'awaiting_approval');
        const urlOf = (key: string): string => (['portalOne', 'portalMulti'].includes(key) ? portalThreads(clientA1) : agencyThreads(agencyA, clientA1));
        const sideOf = (key: string): 'agency' | 'client' => (['portalOne', 'portalMulti'].includes(key) ? 'client' : 'agency');

        const holder = await owner.knex.transaction();
        let released = false;
        try {
          // The first comment is in a transaction that has not committed: its conversation exists only for the unique index.
          const threadId = randomUUID();
          await raw(holder, 'insert into public.client_threads (id, client_id, content_id, opened_by, opened_side) values (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?)', [threadId, clientA1, contentId, users[first]!.id, sideOf(first)]);
          await raw(holder, 'insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body) values (?::uuid, ?::uuid, ?::uuid, ?, ?)', [threadId, clientA1, users[first]!.id, sideOf(first), 'Primeiro']);
          const holderPid = await backendPid(holder);
          const pending = openAs(cookies[second]!, urlOf(second), contentId, 'Segundo');
          await waitForBackendBlockedBy(holderPid);
          await holder.commit();
          released = true;
          const reply = await pending;

          expect(reply.statusCode, `${first} then ${second}`).toBe(201);
          expect(reply.json().thread).toMatchObject({ id: threadId, commentCount: 2, openedBy: { side: sideOf(first) } });
          expect(await threadsOfContent(contentId), `${first} then ${second}`).toHaveLength(1);
          expect((await commentRows(threadId)).map((row) => [row.author_side, row.body]), `${first} then ${second}`).toEqual([[sideOf(first), 'Primeiro'], [sideOf(second), 'Segundo']]);
        } finally {
          if (!released) await holder.rollback();
        }
      }
    }, 60_000);

    it('keeps one conversation when both openings run at the same time, over and over', async () => {
      for (let round = 0; round < 6; round += 1) {
        const contentId = await seedContent(clientA1, 'awaiting_approval');
        const replies = await Promise.all([
          openAs(cookies.manager!, agencyThreads(agencyA, clientA1), contentId, `Agência ${round}`),
          openAs(cookies.portalOne!, portalThreads(clientA1), contentId, `Cliente ${round}`),
          openAs(cookies.production!, agencyThreads(agencyA, clientA1), contentId, `Produção ${round}`)
        ]);
        expect(replies.map((reply) => reply.statusCode), `round ${round}`).toEqual([201, 201, 201]);
        const threads = await threadsOfContent(contentId);
        expect(threads, `round ${round}`).toHaveLength(1);
        expect(new Set(replies.map((reply) => reply.json().thread.id)), `round ${round}`).toEqual(new Set([threads[0]!.id]));
        expect(await commentRows(threads[0]!.id as string), `round ${round}`).toHaveLength(3);
      }
    }, 60_000);
  });
});
