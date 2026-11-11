import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';
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
import { registerErrorHandling } from '../../plugins/infra/errors.js';
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../tenancy/guards.js';
import { registerClientModule } from './routes.js';
import { unusedEmailService } from './test-support/email-service.js';

// Decision 2026-11-10 ("pedido de material"): the agency asks the client for material, with an optional deadline, as a subject of its own
// at the level of the client. The portal reads the open ones of ITS client, comments, and never opens one; only the agency resolves.
// Every scenario of isolation uses a person who belongs to more than one tenant (`portalMulti` with two clients, `dual`, `dualBare` and
// `crossDual` with a link beside an agency role), so a missing filter shows up as a leaked row and not as a policy that hid it.
const origin = { origin: TEST_APP_PUBLIC_URL };

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

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const injectOn = async (target: FastifyInstance, method: 'GET' | 'POST', url: string, cookie: string | undefined, payload?: unknown): Promise<Reply> =>
  (await target.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const call = (method: 'GET' | 'POST', url: string, cookie: string | undefined, payload?: unknown): Promise<Reply> => injectOn(app.app, method, url, cookie, payload);

const agencyThreads = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/threads`;
const portalThreads = (clientId: string): string => `/clients/${clientId}/threads`;
const requestsOf = (clientId: string): string => `/clients/${clientId}/material-requests`;

const MATERIAL = { materialRequest: true };

const openRequest = (cookie: string, clientId: string, body = 'Envie 3 fotos da equipe', dueOn?: string, target: FastifyInstance = app.app, agencyId = agencyA): Promise<Reply> =>
  injectOn(target, 'POST', agencyThreads(agencyId, clientId), cookie, { subject: MATERIAL, body, ...(dueOn === undefined ? {} : { dueOn }) });

const portalComment = (cookie: string, clientId: string, threadId: string, body = 'Segue o material'): Promise<Reply> =>
  call('POST', `${portalThreads(clientId)}/${threadId}/comments`, cookie, { body });

const resolveAs = (cookie: string, clientId: string, threadId: string): Promise<Reply> =>
  call('POST', `${agencyThreads(agencyA, clientId)}/${threadId}/resolve`, cookie, {});

/** The day in São Paulo, `offset` days from now, as `YYYY-MM-DD` (the range of a deadline is the database's, in that time zone). */
const saoPauloDay = (offset = 0): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offset * 86_400_000));

const threadRow = (threadId: string): Promise<Record<string, unknown> | undefined> => owner.knex('client_threads').where({ id: threadId }).first();

const countThreads = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_threads').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const countComments = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_thread_comments').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const idsOf = (reply: Reply): string[] => reply.json().data.map((item: { threadId: string }) => item.threadId);

const errorOf = (reply: Reply): { code?: string; message?: string; details?: { issues?: Array<{ path: string }> } } => {
  const body = reply.json();
  return typeof body.error === 'object' && body.error !== null ? body.error : body;
};

const NO_DATABASE_DETAIL = /A0120|23514|client_threads_|check constraint|deadlock|40P01|pg_|relation|process/i;

const newClient = async (label: string, portalUsers: readonly string[] = []): Promise<string> => {
  const id = randomUUID();
  extraClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyA, name: `Pedido ${label} ${id}` });
  if (portalUsers.length > 0) await owner.knex('client_memberships').insert(portalUsers.map((key) => ({ client_id: id, user_id: users[key]!.id })));
  return id;
};

/** An app over the same database whose every statement goes through `through` first, which may answer with other bindings to send instead. */
const withObservedStatements = async <T>(
  through: (statement: string, bindings: readonly unknown[] | undefined) => readonly unknown[] | undefined,
  run: (proxied: FastifyInstance) => Promise<T>
): Promise<T> => {
  const proxied = Fastify();
  registerErrorHandling(proxied);
  registerClientModule(proxied, {
    database: {
      ...app.database,
      transaction: (work: Parameters<DatabaseClient['transaction']>[0]) =>
        app.database.transaction((transaction) => {
          const wrapped = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === 'raw') {
                return async (statement: string, bindings?: readonly unknown[]) =>
                  target.raw(statement, through(statement.trim(), bindings) as never);
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
    emailService: unusedEmailService,
    photoUrlExpirySeconds: 300
  });
  await proxied.ready();
  try {
    return await run(proxied);
  } finally {
    await proxied.close();
  }
};

const INSERTS_A_THREAD = /^insert into public\.client_threads\b/i;

/**
 * The statement that inserts a thread goes through `rewrite` first: the bindings the service sent are changed to what only a bug
 * could send, so the refusal that the database gives (and nothing earlier) is what the route has to answer.
 */
const withRewrittenThreadInsert = <T>(rewrite: (bindings: unknown[]) => unknown[], run: (proxied: FastifyInstance) => Promise<T>): Promise<T> =>
  withObservedStatements((statement, bindings) => (/^insert into public\.client_threads \(client_id, section_key/i.test(statement) ? rewrite([...(bindings ?? [])]) : bindings), run);

/** Runs `work` on an app that records the statements that insert a thread: what reached the database, not what the route answered. */
const threadInsertsSentBy = async (work: (proxied: FastifyInstance) => Promise<void>): Promise<string[]> => {
  const sent: string[] = [];
  await withObservedStatements((statement, bindings) => {
    if (INSERTS_A_THREAD.test(statement)) sent.push(statement);
    return bindings;
  }, work);
  return sent;
};

describe('CLIENTES request for material (decision 2026-11-10)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['manager', 'Marta Gestora'], ['clientRead', 'Só Lê Clientes'], ['contentOnly', 'Só Conteúdo'],
      ['ownerUser', 'Dona da Agência'], ['otherAdmin', 'Admin da Outra'],
      ['portalOne', 'Ana do Portal'], ['portalMulti', 'Bia dos Dois Clientes'], ['portalOther', 'Portal Outro Cliente'], ['portalB', 'Portal Outra Agência'],
      ['dual', 'Pessoa Dupla'], ['dualBare', 'Pessoa Dupla Sem Papel'], ['crossDual', 'Pessoa Dupla Cruzada']
    ] as const) {
      const user = await insertTestUser(app.pool, app.auth, { emailLabel: `material-${key.toLowerCase()}`, name });
      createdUserIds.push(user.id);
      users[key] = user;
    }

    const systemRoles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => systemRoles.find((candidate) => candidate.key === key)!.id as string;
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Pedido de Material A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Pedido de Material B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      // Reads the conversations and cannot write them: `cliente.operar` is the permission of opening, commenting and resolving.
      { agency_id: agencyA, user_id: users.clientRead!.id, role_id: await customRole('cliente.visualizar') },
      // Passes the guard of the route through `conteudo.operar`, and the service is the only barrier that holds it to the permission of the subject.
      { agency_id: agencyA, user_id: users.contentOnly!.id, role_id: await customRole('conteudo.operar', 'conteudo.visualizar') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: `Pedido A1 ${clientA1}` },
      { id: clientA2, agency_id: agencyA, name: `Pedido A2 ${clientA2}` },
      { id: clientB1, agency_id: agencyB, name: `Pedido B1 ${clientB1}` },
      { id: clientArchived, agency_id: agencyA, name: `Pedido arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() }
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
      { client_id: clientArchived, user_id: users.portalOne!.id }
    ]);

    for (const key of Object.keys(users)) {
      const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
      expect(login.statusCode).toBe(200);
      cookies[key] = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2, clientB1, clientArchived, ...extraClientIds];
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('id', contentIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
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

  describe('the agency opens it', () => {
    it('opens it without a deadline: the subject is the request, the side is the agency, and nothing else is about it', async () => {
      const opened = await openRequest(cookies.manager!, clientA1, 'Envie o logo em alta');
      expect(opened.statusCode).toBe(201);
      const { thread, comment } = opened.json();
      expect(thread).toMatchObject({
        subject: MATERIAL,
        state: 'open',
        openedBy: { name: 'Marta Gestora', side: 'agency' },
        lastComment: { side: 'agency', excerpt: 'Envie o logo em alta' },
        commentCount: 1,
        resolvedBy: null,
        resolvedAt: null,
        dueOn: null
      });
      expect(comment).toMatchObject({ body: 'Envie o logo em alta', side: 'agency', author: { name: 'Marta Gestora' } });
      expect(await threadRow(thread.id)).toMatchObject({
        client_id: clientA1, is_material_request: true, section_key: null, persona_id: null, content_id: null, due_on: null,
        opened_by: users.manager!.id, opened_side: 'agency'
      });
    });

    it('opens it with a deadline, kept as the day it was written', async () => {
      const dueOn = saoPauloDay(10);
      const opened = await openRequest(cookies.admin!, clientA1, 'Envie 3 fotos da equipe', dueOn);
      expect(opened.statusCode).toBe(201);
      expect(opened.json().thread).toMatchObject({ subject: MATERIAL, dueOn });
      expect(await owner.knex('client_threads').where({ id: opened.json().thread.id }).first(owner.knex.raw('due_on::text as due_on'))).toEqual({ due_on: dueOn });
    });

    it('takes the deadline from today to 90 days ahead in São Paulo, and refuses both ends outside it with a 400 that names the field', async () => {
      for (const offset of [0, 90]) {
        expect((await openRequest(cookies.admin!, clientA1, `No limite ${offset}`, saoPauloDay(offset))).statusCode, `+${offset}`).toBe(201);
      }
      const before = { threads: await countThreads(clientA1), comments: await countComments(clientA1) };
      for (const offset of [-1, 91, -400, 4000]) {
        const refused = await openRequest(cookies.admin!, clientA1, `Fora ${offset}`, saoPauloDay(offset));
        expect(refused.statusCode, `${offset}`).toBe(400);
        expect(errorOf(refused)).toMatchObject({ code: 'VALIDATION_ERROR', details: { issues: [{ path: 'dueOn' }] } });
        expect(JSON.stringify(refused.json())).not.toMatch(NO_DATABASE_DETAIL);
      }
      expect({ threads: await countThreads(clientA1), comments: await countComments(clientA1) }).toEqual(before);
    });

    it('refuses a deadline that is not a day, or that comes with another subject, before the database is asked', async () => {
      const before = await countThreads(clientA1);
      for (const dueOn of ['2026-02-30', '20261201', 'amanhã', '', 5]) {
        const refused = await call('POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject: MATERIAL, body: 'x', dueOn });
        expect(refused.statusCode, String(dueOn)).toBe(400);
      }
      for (const subject of [{ sectionKey: 'branding' }, { personaId: randomUUID() }, { contentId: randomUUID() }]) {
        const refused = await call('POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject, body: 'x', dueOn: saoPauloDay(3) });
        expect(refused.statusCode, JSON.stringify(subject)).toBe(400);
        expect(errorOf(refused).details?.issues?.[0]?.path).toBe('dueOn');
      }
      // The subject is the request alone: it never joins another subject, and is never false.
      for (const subject of [{ materialRequest: true, sectionKey: 'branding' }, { materialRequest: false }, { materialRequest: 'true' }]) {
        expect((await call('POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject, body: 'x' })).statusCode, JSON.stringify(subject)).toBe(400);
      }
      expect(await countThreads(clientA1)).toBe(before);
    });

    it('answers a refusal of the database with the same 4xx and never a 500, whatever the route let through', async () => {
      const before = { threads: await countThreads(clientA1), comments: await countComments(clientA1) };

      // A deadline on a thread of the brand study: the check of the table says no, and the answer is the one of the field.
      const withDeadline = await withRewrittenThreadInsert(
        (bindings) => Object.assign([...bindings], { 4: saoPauloDay(5) }),
        (proxied) => injectOn(proxied, 'POST', agencyThreads(agencyA, clientA1), cookies.admin!, { subject: { sectionKey: 'observations' }, body: 'Uma observação' })
      );
      expect(withDeadline.statusCode).toBe(400);
      expect(errorOf(withDeadline)).toMatchObject({ code: 'VALIDATION_ERROR', details: { issues: [{ path: 'dueOn' }] } });

      // A request written on the side of the client: the check of the table says no, and the portal is told it may not. The section is
      // filled, so the checks of the service pass and the insert is what reaches the database.
      await owner.knex('client_brand_sections').insert({ client_id: clientA1, section_key: 'observations', body: 'Texto da agência', updated_by: users.admin!.id });
      const fromThePortal = await withRewrittenThreadInsert(
        (bindings) => Object.assign([...bindings], { 1: null, 3: true }),
        (proxied) => injectOn(proxied, 'POST', portalThreads(clientA1), cookies.portalOne!, { subject: { sectionKey: 'observations' }, body: 'Eu peço' })
      );
      expect(fromThePortal.statusCode).toBe(403);
      expect(errorOf(fromThePortal).code).toBe('FORBIDDEN');

      for (const reply of [withDeadline, fromThePortal]) expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
      expect({ threads: await countThreads(clientA1), comments: await countComments(clientA1) }).toEqual(before);
    });

    it('asks cliente.operar, as every conversation of the client does, and the guard of the route is not enough', async () => {
      const before = { threads: await countThreads(clientA1), comments: await countComments(clientA1) };
      for (const who of ['clientRead', 'contentOnly', 'dualBare']) {
        expect((await openRequest(cookies[who]!, clientA1)).statusCode, who).toBe(403);
      }
      for (const who of ['portalOne', 'portalB', 'otherAdmin', 'crossDual']) {
        expect([403, 404], who).toContain((await openRequest(cookies[who]!, clientA1)).statusCode);
      }
      expect([403, 404]).toContain((await openRequest(cookies.otherAdmin!, clientA1, 'x', undefined, app.app, agencyB)).statusCode);
      expect((await openRequest(cookies.admin!, clientB1)).statusCode).toBe(404);
      expect({ threads: await countThreads(clientA1), comments: await countComments(clientA1) }).toEqual(before);
      expect((await openRequest(cookies.dual!, clientA1)).statusCode).toBe(201);
    });

    it('refuses in the service, before the database, whoever holds conteudo.operar and not cliente.operar (the policy would refuse it too, later)', async () => {
      const client = await newClient('so-conteudo');
      const sent = await threadInsertsSentBy(async (proxied) => {
        for (const who of ['contentOnly', 'clientRead']) {
          const refused = await openRequest(cookies[who]!, client, 'Envie as fotos', undefined, proxied);
          expect(refused.statusCode, who).toBe(403);
          expect(JSON.stringify(refused.json()), who).not.toMatch(NO_DATABASE_DETAIL);
        }
        // The same app does write for who holds the permission, so an empty record is a refusal and not a recorder that sees nothing.
        expect((await openRequest(cookies.manager!, client, 'Envie as fotos', undefined, proxied)).statusCode).toBe(201);
      });
      expect(sent).toHaveLength(1);
      expect(await countThreads(client)).toBe(1);
    });

    it('does not open it for an archived client', async () => {
      const refused = await openRequest(cookies.admin!, clientArchived);
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).code).toBe('CLIENT_ARCHIVED');
      expect(await countThreads(clientArchived)).toBe(0);
    });
  });

  describe('the agency reads and resolves it', () => {
    it('lists it by its subject, with the deadline, apart from every other subject of the client', async () => {
      const client = await newClient('listagem');
      const request = (await openRequest(cookies.admin!, client, 'Peço o manual da marca', saoPauloDay(7))).json().thread;
      await owner.knex('client_threads').insert({ id: randomUUID(), client_id: client, section_key: 'branding', opened_by: users.admin!.id, opened_side: 'agency' });
      await owner.knex.raw(`insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        select id, client_id, ?, 'agency', 'Sobre a marca' from public.client_threads where client_id = ? and section_key = 'branding'`, [users.admin!.id, client]);

      const listed = await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true`, cookies.admin!);
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data).toEqual([expect.objectContaining({ id: request.id, subject: MATERIAL, dueOn: saoPauloDay(7), state: 'open' })]);
      expect(listed.json().meta.totalItems).toBe(1);

      const branding = await call('GET', `${agencyThreads(agencyA, client)}?sectionKey=branding`, cookies.admin!);
      expect(branding.json().data.map((item: { subject: unknown }) => item.subject)).toEqual([{ sectionKey: 'branding' }]);
      expect(branding.json().data[0].dueOn).toBeNull();

      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true&state=resolved`, cookies.admin!)).json().data).toEqual([]);
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true&sectionKey=branding`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=false`, cookies.admin!)).statusCode).toBe(400);
      expect((await call('GET', agencyThreads(agencyA, client), cookies.admin!)).statusCode).toBe(400);
      // Reading asks cliente.visualizar; the permission to read the conversations of a content is not it.
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true`, cookies.clientRead!)).statusCode).toBe(200);
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true`, cookies.contentOnly!)).statusCode).toBe(403);
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true`, cookies.dualBare!)).statusCode).toBe(403);
    });

    it('comments on it and resolves it with the permission of the conversations of the client, and the resolution carries the subject and the deadline', async () => {
      const client = await newClient('resolver', ['portalOne']);
      const request = (await openRequest(cookies.admin!, client, 'Envie o CNPJ', saoPauloDay(4))).json().thread;

      expect((await call('POST', `${agencyThreads(agencyA, client)}/${request.id}/comments`, cookies.manager!, { body: 'Pode ser PDF' })).statusCode).toBe(201);
      for (const who of ['clientRead', 'contentOnly', 'dualBare']) {
        expect((await resolveAs(cookies[who]!, client, request.id)).statusCode, who).toBe(403);
        expect((await call('POST', `${agencyThreads(agencyA, client)}/${request.id}/comments`, cookies[who]!, { body: 'x' })).statusCode, who).toBe(403);
      }
      for (const who of ['portalOne', 'otherAdmin', 'crossDual']) expect([403, 404], who).toContain((await resolveAs(cookies[who]!, client, request.id)).statusCode);
      expect((await threadRow(request.id))?.resolved_at).toBeNull();

      const resolved = await resolveAs(cookies.manager!, client, request.id);
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ id: request.id, subject: MATERIAL, dueOn: saoPauloDay(4), state: 'resolved', resolvedBy: { name: 'Marta Gestora' } });
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true&state=resolved`, cookies.admin!)).json().data).toHaveLength(1);
    });

    it('has no resolve on the portal: the portal route does not exist', async () => {
      const client = await newClient('sem-resolver-no-portal', ['portalOne']);
      const request = (await openRequest(cookies.admin!, client)).json().thread;
      const response = await call('POST', `${portalThreads(client)}/${request.id}/resolve`, cookies.portalOne!, {});
      expect(response.statusCode).toBe(404);
      expect((await threadRow(request.id))?.resolved_at).toBeNull();
    });
  });

  describe('the portal cannot open it', () => {
    it.each(['portalOne', 'portalMulti', 'dual', 'dualBare', 'crossDual'])('answers %s with a 400 on the body and writes nothing, with or without a deadline', async (who) => {
      const before = { threads: await countThreads(clientA1), comments: await countComments(clientA1) };
      for (const payload of [
        { subject: MATERIAL, body: 'Eu peço' },
        { subject: MATERIAL, body: 'Eu peço', dueOn: saoPauloDay(5) },
        { subject: { sectionKey: 'observations' }, body: 'Uma sugestão', dueOn: saoPauloDay(5) }
      ]) {
        const refused = await call('POST', portalThreads(clientA1), cookies[who]!, payload);
        expect(refused.statusCode, `${who} ${JSON.stringify(payload)}`).toBe(400);
        expect(errorOf(refused).code).toBe('VALIDATION_ERROR');
      }
      expect({ threads: await countThreads(clientA1), comments: await countComments(clientA1) }).toEqual(before);
    });

    it('still opens the subjects it always opened', async () => {
      const opened = await call('POST', portalThreads(clientA1), cookies.portalOne!, { subject: { contentId: await seedContent(clientA1, 'awaiting_approval') }, body: 'Ficou ótimo' });
      expect(opened.statusCode).toBe(201);
      expect(opened.json().thread).toMatchObject({ subject: { contentId: expect.any(String) }, dueOn: null, openedBy: { side: 'client' } });
    });
  });

  describe('the portal reads the open ones of its own client', () => {
    it('lists only the requests of that client, for a person with two clients, and each list is the list of its own client', async () => {
      const first = await newClient('lista-um', ['portalMulti']);
      const second = await newClient('lista-dois', ['portalMulti']);
      const inFirst = (await openRequest(cookies.admin!, first, 'Pedido do primeiro cliente', saoPauloDay(6))).json().thread.id as string;
      const inSecond = (await openRequest(cookies.admin!, second, 'Pedido do segundo cliente')).json().thread.id as string;

      const listFirst = await call('GET', requestsOf(first), cookies.portalMulti!);
      expect(listFirst.statusCode).toBe(200);
      expect(listFirst.json().data).toEqual([{
        threadId: inFirst, body: 'Pedido do primeiro cliente', dueOn: saoPauloDay(6), createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/), state: 'open'
      }]);
      expect(listFirst.json().meta).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(idsOf(await call('GET', requestsOf(second), cookies.portalMulti!))).toEqual([inSecond]);
    });

    it.each(['dual', 'dualBare', 'crossDual', 'portalOne'])('reads %s only the requests of the client of the route, although the person reads others through its own policy', async (who) => {
      const own = (await openRequest(cookies.admin!, clientA1, `Pedido de A1 para ${who}`)).json().thread.id as string;
      const other = (await openRequest(cookies.admin!, clientA2, `Pedido de A2 para ${who}`)).json().thread.id as string;
      const ids = idsOf(await call('GET', requestsOf(clientA1), cookies[who]!));
      expect(ids).toContain(own);
      expect(ids).not.toContain(other);
      const items = (await call('GET', requestsOf(clientA1), cookies[who]!)).json().data as Array<{ body: string }>;
      expect(items.some((item) => item.body.includes('A2'))).toBe(false);
    });

    it('is the portal of the client alone: another client, another agency, nobody and an archived client read nothing', async () => {
      await openRequest(cookies.admin!, clientA1, 'Pedido que ninguém de fora lê');
      for (const who of ['portalOther', 'portalB', 'otherAdmin', 'admin', 'manager']) {
        const response = await call('GET', requestsOf(clientA1), cookies[who]!);
        expect(response.statusCode, who).toBe(404);
        expect(errorOf(response)).toMatchObject({ code: 'NOT_FOUND' });
      }
      expect((await call('GET', requestsOf(clientA1), undefined)).statusCode).toBe(401);
      expect((await call('GET', requestsOf(clientArchived), cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('GET', requestsOf('not-a-client'), cookies.portalOne!)).statusCode).toBe(404);
      expect((await call('GET', requestsOf(clientA2), cookies.dualBare!)).statusCode).toBe(404);
      expect((await call('GET', requestsOf(clientA2), cookies.crossDual!)).statusCode).toBe(404);
    });

    it('lists the nearest deadline first and the ones with none last, by pages, with the total from the same snapshot', async () => {
      const client = await newClient('paginas', ['portalOne']);
      const none = (await openRequest(cookies.admin!, client, 'Sem prazo')).json().thread.id as string;
      const late = (await openRequest(cookies.admin!, client, 'Prazo longe', saoPauloDay(20))).json().thread.id as string;
      const soon = (await openRequest(cookies.admin!, client, 'Prazo perto', saoPauloDay(2))).json().thread.id as string;

      expect(idsOf(await call('GET', requestsOf(client), cookies.portalOne!))).toEqual([soon, late, none]);
      const first = await call('GET', `${requestsOf(client)}?pageSize=2`, cookies.portalOne!);
      const second = await call('GET', `${requestsOf(client)}?pageSize=2&page=2`, cookies.portalOne!);
      expect(idsOf(first)).toEqual([soon, late]);
      expect(idsOf(second)).toEqual([none]);
      expect(first.json().meta).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
      const beyond = await call('GET', `${requestsOf(client)}?pageSize=2&page=99`, cookies.portalOne!);
      expect(beyond.json().data).toEqual([]);
      expect(beyond.json().meta).toEqual({ page: 99, pageSize: 2, totalItems: 3, totalPages: 2 });
      for (const query of ['?page=0', '?pageSize=0', '?page=1e20', '?state=resolved', '?clientId=x', '?materialRequest=true']) {
        expect((await call('GET', `${requestsOf(client)}${query}`, cookies.portalOne!)).statusCode, query).toBe(400);
      }
    });

    it('drops the one the agency resolved from the list, and a comment of the client on it brings it back, as in every conversation', async () => {
      const client = await newClient('reabre', ['portalOne']);
      const staying = (await openRequest(cookies.admin!, client, 'Fica aberto')).json().thread.id as string;
      const request = (await openRequest(cookies.admin!, client, 'Será resolvido')).json().thread.id as string;
      expect(new Set(idsOf(await call('GET', requestsOf(client), cookies.portalOne!)))).toEqual(new Set([staying, request]));

      expect((await resolveAs(cookies.admin!, client, request)).statusCode).toBe(200);
      expect(idsOf(await call('GET', requestsOf(client), cookies.portalOne!))).toEqual([staying]);
      // A resolved request stays readable and writable by the portal: it is no longer on the Início, and it is not gone.
      expect((await call('GET', `${portalThreads(client)}/${request}/comments`, cookies.portalOne!)).statusCode).toBe(200);

      expect((await portalComment(cookies.portalOne!, client, request, 'Esqueci de mandar uma foto')).statusCode).toBe(201);
      expect(new Set(idsOf(await call('GET', requestsOf(client), cookies.portalOne!)))).toEqual(new Set([staying, request]));
      expect((await call('GET', `${agencyThreads(agencyA, client)}?materialRequest=true&state=open`, cookies.admin!)).json().data).toHaveLength(2);
    });

    it('never lists a thread that is not a request, and a content in production never reaches the portal through these routes (decision 2026-11-07)', async () => {
      const client = await newClient('producao', ['portalOne']);
      const contentId = await seedContent(client, 'in_production');
      const opened = await call('POST', agencyThreads(agencyA, client), cookies.admin!, { subject: { contentId }, body: 'Nota interna da produção' });
      expect(opened.statusCode).toBe(201);
      const productionThread = opened.json().thread.id as string;
      const request = (await openRequest(cookies.admin!, client, 'Um pedido de verdade')).json().thread.id as string;

      expect(idsOf(await call('GET', requestsOf(client), cookies.portalOne!))).toEqual([request]);
      expect(JSON.stringify((await call('GET', requestsOf(client), cookies.portalOne!)).json())).not.toContain('Nota interna da produção');
      expect((await call('GET', `${portalThreads(client)}/${productionThread}/comments`, cookies.portalOne!)).statusCode).toBe(404);
      expect((await portalComment(cookies.portalOne!, client, productionThread)).statusCode).toBe(404);
      expect((await call('GET', `${portalThreads(client)}?contentId=${contentId}`, cookies.portalOne!)).statusCode).toBe(404);
    });

    it('lists only the open requests of the client, to every person that reaches it, among threads of every other subject of the same client', async () => {
      // `dual` and `dualBare` read the rows of this client through the agency branch of the policy as well, so what keeps the
      // other subjects out of the list is the subject filter of the query, and not a policy that hides them from a portal-only person.
      const client = await newClient('assuntos', ['portalOne', 'dual', 'dualBare', 'crossDual']);
      const contentId = await seedContent(client, 'in_production');
      const planted = {
        production: (await call('POST', agencyThreads(agencyA, client), cookies.admin!, { subject: { contentId }, body: 'NOTA INTERNA DA PRODUCAO' })).json().thread.id as string,
        study: randomUUID(),
        otherSection: randomUUID()
      };
      for (const [id, sectionKey, body] of [[planted.study, 'branding', 'SUGESTAO DO ESTUDO'], [planted.otherSection, 'observations', 'SUGESTAO DE OUTRA SECAO']] as const) {
        await owner.knex('client_threads').insert({ id, client_id: client, section_key: sectionKey, opened_by: users.admin!.id, opened_side: 'agency' });
        await owner.knex('client_thread_comments').insert({ thread_id: id, client_id: client, author_user_id: users.admin!.id, author_side: 'agency', body });
      }
      const open = (await openRequest(cookies.admin!, client, 'Pedido real aberto')).json().thread.id as string;
      const done = (await openRequest(cookies.admin!, client, 'Pedido real resolvido')).json().thread.id as string;
      expect((await resolveAs(cookies.admin!, client, done)).statusCode).toBe(200);
      expect(await countThreads(client)).toBe(5);

      for (const who of ['portalOne', 'dual', 'dualBare', 'crossDual']) {
        const listed = await call('GET', requestsOf(client), cookies[who]!);
        expect(listed.statusCode, who).toBe(200);
        expect(idsOf(listed), who).toEqual([open]);
        expect(listed.json().meta.totalItems, who).toBe(1);
        expect(JSON.stringify(listed.json()), who).not.toMatch(/NOTA INTERNA|SUGESTAO|resolvido/);
      }
    });

    it('lists the requests of its own client through the thread listing too, resolved ones included, and never the ones of another client', async () => {
      const own = await newClient('listagem-do-portal', ['portalMulti']);
      const other = await newClient('listagem-de-outro', ['portalMulti']);
      const open = (await openRequest(cookies.admin!, own, 'Aberto')).json().thread.id as string;
      const done = (await openRequest(cookies.admin!, own, 'Resolvido', saoPauloDay(3))).json().thread.id as string;
      const foreign = (await openRequest(cookies.admin!, other, 'De outro cliente')).json().thread.id as string;
      await resolveAs(cookies.admin!, own, done);

      for (const who of ['portalMulti']) {
        const listed = await call('GET', `${portalThreads(own)}?materialRequest=true`, cookies[who]!);
        expect(listed.statusCode, who).toBe(200);
        const ids = listed.json().data.map((item: { id: string }) => item.id);
        expect(new Set(ids)).toEqual(new Set([open, done]));
        expect(ids).not.toContain(foreign);
        expect(listed.json().data.find((item: { id: string }) => item.id === done)).toMatchObject({ subject: MATERIAL, dueOn: saoPauloDay(3), state: 'resolved' });
      }
      expect((await call('GET', `${portalThreads(clientA1)}?materialRequest=true`, cookies.dualBare!)).statusCode).toBe(200);
      expect((await call('GET', `${portalThreads(clientA1)}?materialRequest=true`, cookies.crossDual!)).statusCode).toBe(200);
      expect((await call('GET', `${portalThreads(clientA2)}?materialRequest=true`, cookies.crossDual!)).statusCode).toBe(404);
    });
  });

  describe('the portal comments on it', () => {
    it.each(['portalOne', 'dual', 'dualBare', 'crossDual'])('lets %s comment with the client side, by its own link, and read the comments back', async (who) => {
      const request = (await openRequest(cookies.admin!, clientA1, `Pedido para ${who}`)).json().thread.id as string;
      const before = await countComments(clientA1);

      const comment = await portalComment(cookies[who]!, clientA1, request, `Resposta de ${who}`);
      expect(comment.statusCode).toBe(201);
      expect(comment.json()).toMatchObject({ body: `Resposta de ${who}`, side: 'client', author: { name: users[who]!.name } });
      const row = await owner.knex('client_thread_comments').where({ id: comment.json().id }).first();
      expect(row).toMatchObject({ author_side: 'client', author_user_id: users[who]!.id, thread_id: request, client_id: clientA1 });
      expect(await countComments(clientA1)).toBe(before + 1);

      const comments = await call('GET', `${portalThreads(clientA1)}/${request}/comments`, cookies[who]!);
      expect(comments.statusCode).toBe(200);
      expect(comments.json().data.map((item: { side: string }) => item.side)).toEqual(['agency', 'client']);
    });

    it('never reaches the request of another client, through the id of the thread, for anybody with a link elsewhere', async () => {
      const foreign = (await openRequest(cookies.admin!, clientA2, 'Pedido de A2')).json().thread.id as string;
      const before = await countComments(clientA2);
      for (const who of ['portalMulti', 'dual', 'dualBare', 'crossDual', 'portalOne']) {
        // The route of A1 and the thread of A2: the person may even hold a link to A2, and the route still names A1.
        expect((await portalComment(cookies[who]!, clientA1, foreign)).statusCode, who).toBe(404);
        expect((await call('GET', `${portalThreads(clientA1)}/${foreign}/comments`, cookies[who]!)).statusCode, who).toBe(404);
      }
      expect((await portalComment(cookies.portalOther!, clientA1, foreign)).statusCode).toBe(404);
      expect((await portalComment(cookies.portalMulti!, clientA2, foreign)).statusCode).toBe(201);
      expect(await countComments(clientA2)).toBe(before + 1);
    });

    it('is refused for an archived client, which the portal does not reach at all', async () => {
      const request = randomUUID();
      await owner.knex('client_threads').insert({ id: request, client_id: clientArchived, is_material_request: true, opened_by: users.admin!.id, opened_side: 'agency' });
      await owner.knex('client_thread_comments').insert({ thread_id: request, client_id: clientArchived, author_user_id: users.admin!.id, author_side: 'agency', body: 'Pedido antigo' });
      expect((await portalComment(cookies.portalOne!, clientArchived, request)).statusCode).toBe(404);
    });
  });

  describe('it is not a suggestion of the brand study, so no count of the study counts it', () => {
    it('keeps it out of "aguardando a agência" and "com resposta da agência" of the agency and of the portal, with a thread of the study as the control', async () => {
      const client = await newClient('contadores', ['portalOne']);
      const portalHome = async (): Promise<{ threadsAnsweredByAgency: number }> => (await call('GET', `/clients/${client}`, cookies.portalOne!)).json().home;
      const summary = async (): Promise<{ threadsAwaitingAgency: number; threadsAnsweredByAgency: number }> =>
        (await call('GET', `/agencies/${agencyA}/clients/${client}`, cookies.admin!)).json().summary;
      const listItem = async (): Promise<{ threadsAwaitingAgency: number }> => {
        const response = await call('GET', `/agencies/${agencyA}/clients?pageSize=100&search=${encodeURIComponent(client)}`, cookies.admin!);
        return response.json().data.find((item: { id: string }) => item.id === client);
      };

      // The agency asks: the last comment is its own, and that is a reply to nobody.
      const request = (await openRequest(cookies.admin!, client, 'Envie as fotos')).json().thread.id as string;
      expect(await portalHome()).toMatchObject({ threadsAnsweredByAgency: 0 });
      expect(await summary()).toMatchObject({ threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0 });
      expect(await listItem()).toMatchObject({ threadsAwaitingAgency: 0 });

      // The client answers: the last comment is the client's, and that is not a suggestion waiting for the agency.
      expect((await portalComment(cookies.portalOne!, client, request, 'Aqui estão')).statusCode).toBe(201);
      expect(await portalHome()).toMatchObject({ threadsAnsweredByAgency: 0 });
      expect(await summary()).toMatchObject({ threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0 });
      expect(await listItem()).toMatchObject({ threadsAwaitingAgency: 0 });

      // The control: a thread of the study on the same client is counted by the same statements.
      const study = randomUUID();
      await owner.knex('client_threads').insert({ id: study, client_id: client, section_key: 'branding', opened_by: users.admin!.id, opened_side: 'agency' });
      await owner.knex('client_thread_comments').insert({ thread_id: study, client_id: client, author_user_id: users.admin!.id, author_side: 'agency', body: 'Sobre a marca' });
      expect(await portalHome()).toMatchObject({ threadsAnsweredByAgency: 1 });
      expect(await summary()).toMatchObject({ threadsAwaitingAgency: 0, threadsAnsweredByAgency: 1 });
      await owner.knex('client_thread_comments').insert({ thread_id: study, client_id: client, author_user_id: users.portalOne!.id, author_side: 'client', body: 'Tenho uma dúvida' });
      expect(await summary()).toMatchObject({ threadsAwaitingAgency: 1, threadsAnsweredByAgency: 0 });
      expect(await listItem()).toMatchObject({ threadsAwaitingAgency: 1 });
    });
  });

  /** A content in the given state, written as the schema owner: the state of a content is only ever moved by functions. */
  async function seedContent(clientId: string, status: 'in_production' | 'awaiting_approval'): Promise<string> {
    const id = randomUUID();
    contentIds.push(id);
    const folder = await owner.knex('media_folders').where({ client_id: clientId, name: 'Imagens', is_default: true }).first('id');
    await owner.knex('contents').insert({
      id,
      client_id: clientId,
      title: `Conteúdo ${id.slice(0, 8)}`,
      platform: 'instagram',
      format: 'image',
      publish_on: '2026-12-20',
      folder_id: folder.id,
      owner_user_id: users.manager!.id,
      status
    });
    return id;
  }
});
