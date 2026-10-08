import { randomUUID } from 'node:crypto';

import { raw, type DatabaseClient } from '@ageniza/database';
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

// Issue #392. The AFTER INSERT triggers of 20261007001400 make a row written into a child of the client wait for the
// archive that holds the client and raise A0020 once it commits. The holder below plays that archive: it has changed the
// client and not committed, the route passes its policy on the snapshot where the client is still active and then waits
// on the trigger, so the order is fixed by the lock and never by a sleep. The route must answer the archived client, with
// nothing written, instead of the 500 an untranslated A0020 would be.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyId = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};
const clientIds: string[] = [];

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'POST' | 'PUT', url: string, cookie: string, payload: unknown): Promise<Reply> =>
  (await app.app.inject({ method, url, headers: { ...origin, cookie }, payload: payload as Record<string, unknown> })) as unknown as Reply;

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `childrace-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

/** A person with no link to any tenant has no context to log into, so this runs after the link exists. */
const signIn = async (key: string): Promise<void> => {
  const user = users[key]!;
  const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(login.statusCode).toBe(200);
  cookies[key] = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const newClient = async (label: string): Promise<string> => {
  const id = randomUUID();
  clientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `Corrida filhas ${label} ${id}` });
  return id;
};

const withPortalPerson = async (clientId: string): Promise<void> => {
  await owner.knex('client_memberships').insert({ client_id: clientId, user_id: users.portal!.id });
};

const withPersona = async (clientId: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_personas').insert({ id, client_id: clientId, name: 'Persona da corrida', updated_by: users.writer!.id });
  return id;
};

const withThread = async (clientId: string, personaId: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('client_threads').insert({ id, client_id: clientId, persona_id: personaId, opened_by: users.writer!.id, opened_side: 'agency' });
  await owner.knex('client_thread_comments').insert({ thread_id: id, client_id: clientId, author_user_id: users.writer!.id, author_side: 'agency', body: 'Primeiro' });
  return id;
};

const countOf = async (table: string, clientId: string): Promise<number> =>
  Number((await owner.knex(table).where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);

const sectionRows = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_brand_sections').where({ client_id: clientId }).count<{ count: string }[]>('client_id as count'))[0]?.count ?? 0);

const statusOf = async (clientId: string): Promise<string> => (await owner.knex('clients').where({ id: clientId }).first()).status as string;

type Holder = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const backendPid = async (transaction: Holder): Promise<number> => {
  const result = await raw<{ rows: Array<{ pid: number }> }>(transaction, 'select pg_catalog.pg_backend_pid() as pid', []);
  return Number(result.rows[0]?.pid);
};

/** Waits until a backend of this database is blocked by the given one, so the race is sequenced by locks and never by a sleep. */
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

const NO_DATABASE_DETAIL = /A0020|deadlock|40P01|pg_|relation|process/i;

/** The route starts while the archive is uncommitted, waits on the client, and is answered after the archive commits. */
const archiveWhileRouteWaits = async (clientId: string, start: () => Promise<Reply>): Promise<Reply> => {
  const holder = await owner.knex.transaction();
  let released = false;
  try {
    const locked = await raw<{ rows: Array<{ id: string }> }>(holder, "update public.clients set status = 'archived', archived_at = now() where id = ?::uuid returning id", [clientId]);
    if (locked.rows.length !== 1) throw new Error('The holder did not archive exactly one client.');
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

const agencyClient = (clientId: string): string => `/agencies/${agencyId}/clients/${clientId}`;

const expectArchived = (reply: Reply): void => {
  expect(reply.statusCode).toBe(409);
  expect(reply.json().error).toEqual({ code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

const expectGoneForThePortal = (reply: Reply): void => {
  expect(reply.statusCode).toBe(404);
  expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message: 'Client not found.' });
  expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
};

describe('CLIENTS routes that write into the children of a client being archived (#392)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    await owner.knex('agencies').insert({ id: agencyId, name: 'Corrida das filhas', owner_user_id: null });
    // One permission alone: an admin holds every key and would hide a guard on the wrong one.
    const roleId = randomUUID();
    createdRoleIds.push(roleId);
    await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `only-operar-${roleId}`, name: 'Só opera', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: roleId, permission_key: 'cliente.operar' });

    await makeUser('writer', 'Quem Escreve');
    await makeUser('portal', 'Pessoa do Portal');
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: users.writer!.id, role_id: roleId });
    await withPortalPerson(await newClient('base'));
    await signIn('writer');
    await signIn('portal');
  });

  afterAll(async () => {
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').where({ id: agencyId }).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('answers 409 CLIENT_ARCHIVED to a brand study section written while the client is archived, and writes none', async () => {
    const clientId = await newClient('secao');
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('PUT', `${agencyClient(clientId)}/brand-study/sections/branding`, cookies.writer!, { body: 'Marca acolhedora.' }));

    expectArchived(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await sectionRows(clientId)).toBe(0);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a persona created while the client is archived, and creates none', async () => {
    const clientId = await newClient('persona');
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('POST', `${agencyClient(clientId)}/personas`, cookies.writer!, { name: 'Chegou tarde' }));

    expectArchived(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await countOf('client_personas', clientId)).toBe(0);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a thread opened by the agency while the client is archived, and opens none, not even its comment', async () => {
    const clientId = await newClient('conversa');
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('POST', `${agencyClient(clientId)}/threads`, cookies.writer!, { subject: { sectionKey: 'branding' }, body: 'Chegou tarde' }));

    expectArchived(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await countOf('client_threads', clientId)).toBe(0);
    expect(await countOf('client_thread_comments', clientId)).toBe(0);
  }, 30_000);

  it('answers 409 CLIENT_ARCHIVED to a comment by the agency while the client is archived, leaving the thread as it was', async () => {
    const clientId = await newClient('comentario');
    const threadId = await withThread(clientId, await withPersona(clientId));
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('POST', `${agencyClient(clientId)}/threads/${threadId}/comments`, cookies.writer!, { body: 'Chegou tarde' }));

    expectArchived(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await countOf('client_thread_comments', clientId)).toBe(1);
  }, 30_000);

  it('answers the portal 404 to a thread opened while the client is archived, as it does for an archived client everywhere else', async () => {
    const clientId = await newClient('portal-conversa');
    await withPortalPerson(clientId);
    const personaId = await withPersona(clientId);
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('POST', `/clients/${clientId}/threads`, cookies.portal!, { subject: { personaId }, body: 'Chegou tarde' }));

    expectGoneForThePortal(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await countOf('client_threads', clientId)).toBe(0);
    expect(await countOf('client_thread_comments', clientId)).toBe(0);
  }, 30_000);

  it('answers the portal 404 to a comment written while the client is archived, leaving the thread as it was', async () => {
    const clientId = await newClient('portal-comentario');
    await withPortalPerson(clientId);
    const threadId = await withThread(clientId, await withPersona(clientId));
    const reply = await archiveWhileRouteWaits(clientId, () =>
      call('POST', `/clients/${clientId}/threads/${threadId}/comments`, cookies.portal!, { body: 'Chegou tarde' }));

    expectGoneForThePortal(reply);
    expect(await statusOf(clientId)).toBe('archived');
    expect(await countOf('client_thread_comments', clientId)).toBe(1);
  }, 30_000);
});
