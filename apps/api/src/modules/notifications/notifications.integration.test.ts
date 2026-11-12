import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';

// Notifications inside the app (specs/notificacoes.md, API layer). The notification is the person's alone, so every route is probed with
// the kinds of person who could reach for another's: the Owner and an Admin of the same agency, a collaborator whose role holds no key,
// the Admin of another agency with a link to a client here (`crossDual`), one who only has a link (`portalOne`) and a person of two agencies.
// Every refusal is checked by the state left in the database, because RLS answers an empty result and the route answers a status.
const origin = { origin: TEST_APP_PUBLIC_URL };
const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|40001|42501|22P02|pg_|relation|app_private|injected/i;

let owner: DatabaseClient;
let app: TestApp;
// The failure the wrapped database raises for the next statement that names a notification; undefined: none.
let injected: { readonly code: string } | undefined;

const agencyA = randomUUID();
const agencyB = randomUUID();
const cMain = randomUUID();
const cB = randomUUID();

const userIds: string[] = [];
const roleIds: string[] = [];
const contentIds: string[] = [];
const threadIds: string[] = [];
const invitationIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const cookieOf = (response: { cookies: readonly { name: string; value: string }[] }): string =>
  response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const call = async (method: 'GET' | 'POST', url: string, as?: string): Promise<Reply> =>
  (await app.app.inject({ method, url, headers: { ...origin, ...(as === undefined ? {} : { cookie: cookies[as]! }) } })) as unknown as Reply;

const listUrl = (agency: string, query = ''): string => `/agencies/${agency}/notifications${query}`;
const countUrl = (agency: string): string => `/agencies/${agency}/notifications/unread-count`;
const readUrl = (agency: string, notification: string): string => `/agencies/${agency}/notifications/${notification}/read`;
const readAllUrl = (agency: string): string => `/agencies/${agency}/notifications/read-all`;

/** The four routes, one by one, so a probe of a guard names the route that failed and a mutation of one route's guard turns that route red. */
const everyRoute = (agency: string, notification: string): ReadonlyArray<{ readonly name: string; readonly method: 'GET' | 'POST'; readonly url: string }> => [
  { name: 'list', method: 'GET', url: listUrl(agency) },
  { name: 'unread-count', method: 'GET', url: countUrl(agency) },
  { name: 'read', method: 'POST', url: readUrl(agency, notification) },
  { name: 'read-all', method: 'POST', url: readAllUrl(agency) }
];

type Kind = 'content_approved' | 'content_changes_requested' | 'material_request_answered' | 'approval_deadline_passed' | 'invitation_accepted';

interface Seed {
  readonly id?: string;
  readonly agency?: string;
  readonly client?: string;
  readonly content?: string;
  readonly thread?: string;
  readonly invitation?: string;
  readonly round?: string;
  readonly createdAt?: Date;
  readonly read?: boolean;
  readonly summary?: string;
}

const defaultFolderOf = async (clientId: string): Promise<string> =>
  (await owner.knex('media_folders').where({ client_id: clientId, is_default: true }).first('id')).id as string;

const seedContent = async (clientId: string, ownerUser: string, title = 'Promoção de pães'): Promise<string> => {
  const id = randomUUID();
  contentIds.push(id);
  await owner.knex('contents').insert({
    id, client_id: clientId, title, platform: 'instagram', format: 'reels', publish_on: '2026-10-20', publish_at_time: '18:30',
    caption: 'Legenda', folder_id: await defaultFolderOf(clientId), owner_user_id: ownerUser, status: 'in_production'
  });
  return id;
};

const seedThread = async (clientId: string, openedBy: string): Promise<string> => {
  const id = randomUUID();
  threadIds.push(id);
  await owner.knex('client_threads').insert({ id, client_id: clientId, is_material_request: true, title: 'Logo da marca', opened_by: openedBy, opened_side: 'agency' });
  return id;
};

const seedInvitation = async (agency: string, purpose: 'collaborator_invite' | 'client_invite', client: string | null = null): Promise<string> => {
  const id = randomUUID();
  invitationIds.push(id);
  const role = purpose === 'collaborator_invite' ? (await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id : null;
  await owner.knex('invitations').insert({
    id, agency_id: agency, purpose, email: `${id}@notifications.test`, client_id: client, role_id: role, token_hash: `hash-${id}`,
    expires_at: new Date(Date.now() + 86_400_000)
  });
  return id;
};

let tick = 0;
/** Inserts a notification as the owner of the database: the application role cannot, and no route does. */
const notify = async (recipient: string, kind: Kind, seed: Seed = {}): Promise<string> => {
  const id = seed.id ?? randomUUID();
  tick += 1;
  await owner.knex('notifications').insert({
    id,
    agency_id: seed.agency ?? agencyA,
    recipient_user_id: recipient,
    kind,
    content_id: seed.content ?? null,
    thread_id: seed.thread ?? null,
    invitation_id: seed.invitation ?? null,
    client_id: seed.client ?? null,
    approval_round_id: seed.round ?? null,
    summary: seed.summary ?? `Aviso ${tick}`,
    created_at: seed.createdAt ?? new Date(Date.UTC(2026, 10, 1, 12, tick)),
    read_at: seed.read === true ? new Date(Date.UTC(2026, 10, 2, 12, 0)) : null
  });
  return id;
};

const readAtOf = async (id: string): Promise<Date | null> => (await owner.knex('notifications').where({ id }).first('read_at')).read_at as Date | null;

const unreadOf = async (recipient: string, agency = agencyA): Promise<number> =>
  Number((await owner.knex('notifications').where({ recipient_user_id: recipient, agency_id: agency }).whereNull('read_at').count<{ count: string }[]>('id as count'))[0]?.count);

const idsOf = (reply: Reply): string[] => reply.json().data.map((item: { id: string }) => item.id);

const expectNotFound = (reply: Reply, message: string): void => {
  expect(reply.statusCode).toBe(404);
  expect(reply.json().error).toEqual({ code: 'NOT_FOUND', message });
};

const failing = (database: DatabaseClient): DatabaseClient => ({
  ...database,
  transaction: (work) => database.transaction((transaction) => work(new Proxy(transaction, {
    get(target, property) {
      if (property === 'raw') {
        return (statement: string, ...rest: unknown[]) => {
          if (injected !== undefined && /notification/.test(String(statement))) throw Object.assign(new Error('injected failure of the database'), { code: injected.code });
          return (target.raw as (...args: unknown[]) => unknown)(statement, ...rest);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  })))
});

let veraRole: string;

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp({ wrapDatabase: failing });

  const people: ReadonlyArray<readonly [string, string]> = [
    ['owner', 'Dona da Agência'], ['ownerB', 'Dono da Outra'], ['rita', 'Rita Responsável'], ['tom', 'Tom Colega'], ['admin', 'Admin da Agência'],
    ['vera', 'Vera Perde Permissão'], ['twoAgencies', 'Leitora de Duas Agências'], ['dualBare', 'Eva Dupla Sem Papel'],
    ['crossDual', 'Admin da Outra com Vínculo'], ['portalOne', 'Pessoa do Portal'], ['outsider', 'De Fora'], ['pager', 'Paula Paginada']
  ];
  for (const [key, name] of people) {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: `notif-${key.toLowerCase()}`, name });
    userIds.push(user.id);
    users[key] = user;
  }

  await owner.knex('agencies').insert([
    { id: agencyA, name: `Notificações A ${agencyA}`, owner_user_id: users.owner!.id },
    { id: agencyB, name: `Notificações B ${agencyB}`, owner_user_id: users.ownerB!.id }
  ]);
  await owner.knex('clients').insert([
    { id: cMain, agency_id: agencyA, name: `Padaria Sol ${cMain}` },
    { id: cB, agency_id: agencyB, name: `Cliente B ${cB}` }
  ]);

  const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
    const id = randomUUID();
    roleIds.push(id);
    await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
    if (permissions.length > 0) await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
    return id;
  };
  const system = async (key: string): Promise<string> => (await owner.knex('roles').whereNull('agency_id').where({ key }).first('id')).id as string;

  const readsEverything = ['conteudo.visualizar', 'cliente.visualizar', 'colaborador.visualizar'];
  veraRole = await customRole(agencyA, ...readsEverything);

  await owner.knex('agency_memberships').insert([
    { agency_id: agencyA, user_id: users.rita!.id, role_id: await customRole(agencyA, ...readsEverything) },
    { agency_id: agencyA, user_id: users.tom!.id, role_id: await customRole(agencyA, ...readsEverything) },
    { agency_id: agencyA, user_id: users.admin!.id, role_id: await system('admin') },
    { agency_id: agencyA, user_id: users.vera!.id, role_id: veraRole },
    { agency_id: agencyA, user_id: users.twoAgencies!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') },
    { agency_id: agencyB, user_id: users.twoAgencies!.id, role_id: await customRole(agencyB, 'conteudo.visualizar') },
    { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole(agencyA, 'midia.enviar') },
    { agency_id: agencyB, user_id: users.crossDual!.id, role_id: await system('admin') },
    { agency_id: agencyA, user_id: users.pager!.id, role_id: await customRole(agencyA, 'conteudo.visualizar') }
  ]);
  await owner.knex('client_memberships').insert([users.dualBare, users.crossDual, users.portalOne].map((user) => ({ client_id: cMain, user_id: user!.id })));

  for (const key of Object.keys(users)) {
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users[key]!.email, password: users[key]!.password } });
    expect(response.statusCode, key).toBe(200);
    cookies[key] = cookieOf(response);
  }
});

afterAll(async () => {
  const agencies = [agencyA, agencyB];
  const clients = [cMain, cB];
  await owner.knex('notifications').whereIn('agency_id', agencies).delete();
  await owner.knex('content_approval_rounds').whereIn('client_id', clients).delete();
  await owner.knex('contents').whereIn('id', contentIds).delete();
  await owner.knex('client_threads').whereIn('id', threadIds).delete();
  await owner.knex('invitations').whereIn('id', invitationIds).delete();
  await owner.knex('client_memberships').whereIn('client_id', clients).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', agencies).delete();
  await owner.knex('media_folders').whereIn('client_id', clients).delete();
  await owner.knex('clients').whereIn('id', clients).delete();
  await owner.knex('role_permissions').whereIn('role_id', roleIds).delete();
  await owner.knex('roles').whereIn('id', roleIds).delete();
  await owner.knex('audit.events').whereIn('agency_id', agencies).delete();
  await owner.knex('agencies').whereIn('id', agencies).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', agencies).delete();
  await owner.knex('auth.user').whereIn('id', userIds).delete();
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  injected = undefined;
  await owner.knex('notifications').whereIn('agency_id', [agencyA, agencyB]).delete();
  await owner.knex('agencies').where({ id: agencyA }).update({ status: 'active' });
});

/** Rita has five, one of each kind, the second to last read; Tom has one of his own. The latest is the deadline one. */
const seedTheTeam = async () => {
  const content = await seedContent(cMain, users.rita!.id);
  const thread = await seedThread(cMain, users.rita!.id);
  const invitation = await seedInvitation(agencyA, 'collaborator_invite');
  const round = randomUUID();
  await owner.knex('content_approval_rounds').insert({
    id: round, batch_id: randomUUID(), client_id: cMain, content_id: content, sequence: 1, sent_by: users.rita!.id, note: 'Preciso do seu OK.',
    sent_at: new Date(Date.UTC(2026, 10, 1, 10, 0))
  });
  const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 3, 12, minute));
  const ids = {
    approved: await notify(users.rita!.id, 'content_approved', { content, client: cMain, createdAt: at(1), summary: 'Padaria Sol aprovou "Promoção de pães"' }),
    changes: await notify(users.rita!.id, 'content_changes_requested', { content, client: cMain, createdAt: at(2), summary: 'Padaria Sol pediu ajuste em "Promoção de pães"' }),
    material: await notify(users.rita!.id, 'material_request_answered', { thread, client: cMain, createdAt: at(3), summary: 'Padaria Sol respondeu "Logo da marca"' }),
    invitation: await notify(users.rita!.id, 'invitation_accepted', { invitation, createdAt: at(4), read: true, summary: 'Ana aceitou o seu convite' }),
    deadline: await notify(users.rita!.id, 'approval_deadline_passed', { content, client: cMain, round, createdAt: at(5), summary: 'O prazo de "Promoção de pães" venceu' })
  };
  const tom = await notify(users.tom!.id, 'content_approved', { content, client: cMain, createdAt: at(6), summary: 'Aviso de Tom' });
  return { ids, tom, content, thread, invitation, round };
};

describe('who reads which notifications', () => {
  it('lists and counts only the notifications of the person, newest first, whoever else is in the agency', async () => {
    const { ids, tom } = await seedTheTeam();

    const list = await call('GET', listUrl(agencyA), 'rita');
    expect(list.statusCode).toBe(200);
    expect(idsOf(list)).toEqual([ids.deadline, ids.invitation, ids.material, ids.changes, ids.approved]);
    expect(list.json().meta).toEqual({ page: 1, pageSize: 20, totalItems: 5, totalPages: 1 });
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 4 } });

    expect(idsOf(await call('GET', listUrl(agencyA), 'tom'))).toEqual([tom]);
    expect((await call('GET', countUrl(agencyA), 'tom')).json()).toEqual({ data: { count: 1 } });
  });

  it.each(['owner', 'admin', 'vera', 'pager'] as const)('shows %s none of the notifications of Rita, though they belong to the same agency, and counts none', async (as) => {
    await seedTheTeam();

    const list = await call('GET', listUrl(agencyA), as);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    expect((await call('GET', countUrl(agencyA), as)).json()).toEqual({ data: { count: 0 } });
  });

  it('answers the collaborator whose role holds no key with an empty list and a zero, even for a notification addressed to them', async () => {
    const { content } = await seedTheTeam();
    // The policy asks for the permission of the subject at every read: this one is hers by address and not hers to read.
    await notify(users.dualBare!.id, 'content_approved', { content, client: cMain, summary: 'Sem permissão' });

    expect((await call('GET', listUrl(agencyA), 'dualBare')).json().data).toEqual([]);
    expect((await call('GET', countUrl(agencyA), 'dualBare')).json()).toEqual({ data: { count: 0 } });
  });

  it('refuses the person who is not in the agency, and the one who only has a link with a client, on every route, and changes nothing', async () => {
    const { ids } = await seedTheTeam();
    const before = [await unreadOf(users.rita!.id), await readAtOf(ids.approved)];

    for (const as of ['crossDual', 'portalOne', 'outsider', 'ownerB']) {
      for (const route of everyRoute(agencyA, ids.approved)) {
        const reply = await call(route.method, route.url, as);
        expect({ as, route: route.name, status: reply.statusCode, body: reply.json().error }).toEqual({ as, route: route.name, status: 404, body: { code: 'NOT_FOUND', message: 'Agency not found.' } });
      }
    }

    expect([await unreadOf(users.rita!.id), await readAtOf(ids.approved)]).toEqual(before);
  });

  it('answers 401 to a request with no session, on every route', async () => {
    const { ids } = await seedTheTeam();
    for (const route of everyRoute(agencyA, ids.approved)) {
      const reply = await call(route.method, route.url);
      expect({ route: route.name, status: reply.statusCode, code: reply.json().error.code }).toEqual({ route: route.name, status: 401, code: 'UNAUTHENTICATED' });
    }
    expect(await readAtOf(ids.approved)).toBeNull();
  });

  it('refuses an agency id that is not a uuid, with 400, on every route', async () => {
    for (const route of everyRoute('not-a-uuid', randomUUID())) {
      const reply = await call(route.method, route.url, 'rita');
      expect({ route: route.name, status: reply.statusCode, code: reply.json().error.code }).toEqual({ route: route.name, status: 400, code: 'VALIDATION_ERROR' });
    }
  });

  it('closes an agency that is suspended to every route', async () => {
    const { ids } = await seedTheTeam();
    await owner.knex('agencies').where({ id: agencyA }).update({ status: 'suspended' });

    for (const route of everyRoute(agencyA, ids.approved)) {
      expectNotFound(await call(route.method, route.url, 'rita'), 'Agency not found.');
    }
    expect(await readAtOf(ids.approved)).toBeNull();
  });

  it('keeps the agencies apart for a person who is in both: each list and each count has the rows of its own agency only', async () => {
    const contentA = await seedContent(cMain, users.rita!.id);
    const contentB = await seedContent(cB, users.twoAgencies!.id);
    const inA = await notify(users.twoAgencies!.id, 'content_approved', { content: contentA, client: cMain, summary: 'Na A' });
    const inB = await notify(users.twoAgencies!.id, 'content_approved', { agency: agencyB, content: contentB, client: cB, summary: 'Na B' });
    const inBToo = await notify(users.twoAgencies!.id, 'content_changes_requested', { agency: agencyB, content: contentB, client: cB, summary: 'Na B também' });

    expect(idsOf(await call('GET', listUrl(agencyA), 'twoAgencies'))).toEqual([inA]);
    expect((await call('GET', countUrl(agencyA), 'twoAgencies')).json()).toEqual({ data: { count: 1 } });
    expect(idsOf(await call('GET', listUrl(agencyB), 'twoAgencies'))).toEqual([inBToo, inB]);
    expect((await call('GET', countUrl(agencyB), 'twoAgencies')).json()).toEqual({ data: { count: 2 } });
  });
});

describe('losing the permission of the subject', () => {
  it('takes the notification out of the list and the count while the permission is gone, and brings it back with the permission', async () => {
    const content = await seedContent(cMain, users.rita!.id);
    const thread = await seedThread(cMain, users.rita!.id);
    const ofContent = await notify(users.vera!.id, 'content_approved', { content, client: cMain, createdAt: new Date(Date.UTC(2026, 10, 3, 12, 1)) });
    const ofRequest = await notify(users.vera!.id, 'material_request_answered', { thread, client: cMain, createdAt: new Date(Date.UTC(2026, 10, 3, 12, 2)) });
    expect(idsOf(await call('GET', listUrl(agencyA), 'vera'))).toEqual([ofRequest, ofContent]);
    expect((await call('GET', countUrl(agencyA), 'vera')).json()).toEqual({ data: { count: 2 } });

    await owner.knex('role_permissions').where({ role_id: veraRole, permission_key: 'conteudo.visualizar' }).delete();
    try {
      expect(idsOf(await call('GET', listUrl(agencyA), 'vera'))).toEqual([ofRequest]);
      expect((await call('GET', listUrl(agencyA), 'vera')).json().meta.totalItems).toBe(1);
      expect((await call('GET', countUrl(agencyA), 'vera')).json()).toEqual({ data: { count: 1 } });

      await owner.knex('role_permissions').where({ role_id: veraRole, permission_key: 'cliente.visualizar' }).delete();
      expect((await call('GET', listUrl(agencyA), 'vera')).json().data).toEqual([]);
      expect((await call('GET', countUrl(agencyA), 'vera')).json()).toEqual({ data: { count: 0 } });
    } finally {
      await owner.knex('role_permissions').insert([
        { role_id: veraRole, permission_key: 'conteudo.visualizar' },
        { role_id: veraRole, permission_key: 'cliente.visualizar' }
      ]).onConflict().ignore();
    }
    expect(idsOf(await call('GET', listUrl(agencyA), 'vera'))).toEqual([ofRequest, ofContent]);
  });

  it('answers 404 to reading the one whose permission was lost, and leaves it unread', async () => {
    const content = await seedContent(cMain, users.rita!.id);
    const lost = await notify(users.vera!.id, 'content_approved', { content, client: cMain });
    await owner.knex('role_permissions').where({ role_id: veraRole, permission_key: 'conteudo.visualizar' }).delete();
    try {
      expectNotFound(await call('POST', readUrl(agencyA, lost), 'vera'), 'Notification not found.');
      expect((await call('POST', readAllUrl(agencyA), 'vera')).statusCode).toBe(204);
      expect(await readAtOf(lost)).toBeNull();
    } finally {
      await owner.knex('role_permissions').insert({ role_id: veraRole, permission_key: 'conteudo.visualizar' }).onConflict().ignore();
    }
  });
});

describe('where each notification leads', () => {
  it('gives each kind the destination its screen needs, and the summary and the instants as stored', async () => {
    const { ids, content, thread } = await seedTheTeam();

    const items = (await call('GET', listUrl(agencyA), 'rita')).json().data as Array<Record<string, unknown>>;
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(ids.approved)).toEqual({
      id: ids.approved, kind: 'content_approved', summary: 'Padaria Sol aprovou "Promoção de pães"', createdAt: '2026-11-03T12:01:00.000Z', readAt: null,
      destination: { type: 'content', clientId: cMain, contentId: content }
    });
    expect(byId.get(ids.changes)).toMatchObject({ kind: 'content_changes_requested', destination: { type: 'content', clientId: cMain, contentId: content } });
    expect(byId.get(ids.deadline)).toMatchObject({ kind: 'approval_deadline_passed', destination: { type: 'content', clientId: cMain, contentId: content } });
    expect(byId.get(ids.material)).toMatchObject({ kind: 'material_request_answered', destination: { type: 'material-request', clientId: cMain, threadId: thread } });
    expect(byId.get(ids.invitation)).toEqual({
      id: ids.invitation, kind: 'invitation_accepted', summary: 'Ana aceitou o seu convite', createdAt: '2026-11-03T12:04:00.000Z', readAt: '2026-11-02T12:00:00.000Z',
      destination: { type: 'collaborators' }
    });
  });
});

describe('reading one notification', () => {
  it('marks the notification of the person as read, answers 204, and keeps the instant of the first reading when it is read again', async () => {
    const { ids } = await seedTheTeam();

    const first = await call('POST', readUrl(agencyA, ids.approved), 'rita');
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');
    const readAt = await readAtOf(ids.approved);
    expect(readAt).toBeInstanceOf(Date);

    expect((await call('POST', readUrl(agencyA, ids.approved), 'rita')).statusCode).toBe(204);
    expect(await readAtOf(ids.approved)).toEqual(readAt);
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 3 } });
    expect((await call('GET', listUrl(agencyA), 'rita')).json().data.find((item: { id: string }) => item.id === ids.approved).readAt).toBe(readAt!.toISOString());
  });

  it.each(['tom', 'admin', 'owner', 'vera'] as const)('answers 404 to %s reading the notification of Rita, and the notification stays unread', async (as) => {
    const { ids } = await seedTheTeam();

    expectNotFound(await call('POST', readUrl(agencyA, ids.approved), as), 'Notification not found.');

    expect(await readAtOf(ids.approved)).toBeNull();
    expect(await unreadOf(users.rita!.id)).toBe(4);
  });

  it('answers 404 to a notification of another agency read through this one, and 204 through its own', async () => {
    const contentB = await seedContent(cB, users.twoAgencies!.id);
    const inB = await notify(users.twoAgencies!.id, 'content_approved', { agency: agencyB, content: contentB, client: cB });

    expectNotFound(await call('POST', readUrl(agencyA, inB), 'twoAgencies'), 'Notification not found.');
    expect(await readAtOf(inB)).toBeNull();
    expect((await call('POST', readUrl(agencyB, inB), 'twoAgencies')).statusCode).toBe(204);
    expect(await readAtOf(inB)).toBeInstanceOf(Date);
  });

  it('answers 404 to a notification that does not exist, the same as to the one of another person, and changes nothing', async () => {
    const { ids } = await seedTheTeam();
    const before = await unreadOf(users.rita!.id);

    const missing = await call('POST', readUrl(agencyA, randomUUID()), 'rita');
    const another = await call('POST', readUrl(agencyA, ids.approved), 'tom');

    expectNotFound(missing, 'Notification not found.');
    expect(missing.json().error).toEqual(another.json().error);
    expect(await unreadOf(users.rita!.id)).toBe(before);
    expect(missing.body).not.toMatch(NO_DATABASE_DETAIL);
  });

  it.each(['not-a-uuid', '123', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', '%27%3Bselect%201', '00000000-0000-0000-0000-00000000000g'])(
    'answers 400, never 500, to the notification id %s',
    async (notification) => {
      const { ids } = await seedTheTeam();

      const reply = await call('POST', readUrl(agencyA, notification), 'rita');

      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('VALIDATION_ERROR');
      expect(reply.body).not.toMatch(NO_DATABASE_DETAIL);
      expect(await unreadOf(users.rita!.id)).toBe(4);
      expect(await readAtOf(ids.approved)).toBeNull();
    }
  );

  it('survives the same notification read at once from several requests: every one answers 204 and the first instant stays', async () => {
    const { ids } = await seedTheTeam();

    const replies = await Promise.all([1, 2, 3, 4].map(() => call('POST', readUrl(agencyA, ids.material), 'rita')));

    expect(replies.map((reply) => reply.statusCode)).toEqual([204, 204, 204, 204]);
    expect(await readAtOf(ids.material)).toBeInstanceOf(Date);
  });
});

describe('reading all of them', () => {
  it('marks every unread notification of the person in the agency, answers 204, and touches nobody else', async () => {
    const { ids, tom } = await seedTheTeam();
    const alreadyRead = await readAtOf(ids.invitation);

    const reply = await call('POST', readAllUrl(agencyA), 'rita');

    expect(reply.statusCode).toBe(204);
    expect(reply.body).toBe('');
    expect(await unreadOf(users.rita!.id)).toBe(0);
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 0 } });
    // The one that was read keeps its instant; Tom's stays unread.
    expect(await readAtOf(ids.invitation)).toEqual(alreadyRead);
    expect(await readAtOf(tom)).toBeNull();
    expect((await call('GET', countUrl(agencyA), 'tom')).json()).toEqual({ data: { count: 1 } });
  });

  it('marks only the agency of the route for a person who is in two, and answers 204 when there is nothing to mark', async () => {
    const contentA = await seedContent(cMain, users.rita!.id);
    const contentB = await seedContent(cB, users.twoAgencies!.id);
    const inA = await notify(users.twoAgencies!.id, 'content_approved', { content: contentA, client: cMain });
    const inB = await notify(users.twoAgencies!.id, 'content_approved', { agency: agencyB, content: contentB, client: cB });

    expect((await call('POST', readAllUrl(agencyA), 'twoAgencies')).statusCode).toBe(204);
    expect(await readAtOf(inA)).toBeInstanceOf(Date);
    expect(await readAtOf(inB)).toBeNull();
    expect((await call('POST', readAllUrl(agencyA), 'twoAgencies')).statusCode).toBe(204);
    expect(await readAtOf(inB)).toBeNull();
    expect((await call('POST', readAllUrl(agencyB), 'twoAgencies')).statusCode).toBe(204);
    expect(await readAtOf(inB)).toBeInstanceOf(Date);
  });

  it('does nothing for the person who has none, the Owner and an Admin included, and leaves the others as they were', async () => {
    const { ids } = await seedTheTeam();

    for (const as of ['owner', 'admin', 'dualBare']) expect((await call('POST', readAllUrl(agencyA), as)).statusCode, as).toBe(204);

    expect(await unreadOf(users.rita!.id)).toBe(4);
    expect(await readAtOf(ids.approved)).toBeNull();
  });

  it('survives several requests at once: every one answers 204 and all are read', async () => {
    await seedTheTeam();

    const replies = await Promise.all([1, 2, 3, 4].map(() => call('POST', readAllUrl(agencyA), 'rita')));

    expect(replies.map((reply) => reply.statusCode)).toEqual([204, 204, 204, 204]);
    expect(await unreadOf(users.rita!.id)).toBe(0);
  });
});

describe('the pages of the list', () => {
  const total = 45;
  let expectedOrder: string[] = [];
  let unreadOrder: string[] = [];

  beforeEach(async () => {
    const content = await seedContent(cMain, users.rita!.id);
    // Ids ascending in the order they are inserted, and five of them share an instant: the physical order is the opposite of "id descending",
    // so only the tie-break of the query puts them right.
    const sortedIds = Array.from({ length: total }, () => randomUUID()).sort();
    const rows = sortedIds.map((id, index) => ({
      id, createdAt: new Date(Date.UTC(2026, 10, 1, 12, index >= 10 && index <= 14 ? 10 : index)), read: index % 3 === 0
    }));
    for (const row of rows) await notify(users.pager!.id, 'content_approved', { id: row.id, content, client: cMain, createdAt: row.createdAt, read: row.read });
    const newestFirst = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    expectedOrder = newestFirst.map((row) => row.id);
    unreadOrder = newestFirst.filter((row) => !row.read).map((row) => row.id);
  });

  it('gives 20 to a page, the latest first, the id breaking a tie, and no notification twice or lost across the pages', async () => {
    const pages = [await call('GET', listUrl(agencyA), 'pager'), await call('GET', listUrl(agencyA, '?page=2'), 'pager'), await call('GET', listUrl(agencyA, '?page=3'), 'pager')];

    expect(pages.map((page) => idsOf(page).length)).toEqual([20, 20, 5]);
    expect(pages.flatMap(idsOf)).toEqual(expectedOrder);
    expect(pages.map((page) => page.json().meta)).toEqual([
      { page: 1, pageSize: 20, totalItems: 45, totalPages: 3 },
      { page: 2, pageSize: 20, totalItems: 45, totalPages: 3 },
      { page: 3, pageSize: 20, totalItems: 45, totalPages: 3 }
    ]);
  });

  it('lists only the unread ones with unread=true, in the same order, and counts them', async () => {
    const pages = [await call('GET', listUrl(agencyA, '?unread=true'), 'pager'), await call('GET', listUrl(agencyA, '?unread=true&page=2'), 'pager')];

    expect(pages.flatMap(idsOf)).toEqual(unreadOrder);
    expect(pages.map((page) => page.json().meta)).toEqual([
      { page: 1, pageSize: 20, totalItems: 30, totalPages: 2 },
      { page: 2, pageSize: 20, totalItems: 30, totalPages: 2 }
    ]);
    expect(pages.flatMap((page) => page.json().data).every((item: { readAt: string | null }) => item.readAt === null)).toBe(true);
    expect((await call('GET', countUrl(agencyA), 'pager')).json()).toEqual({ data: { count: 30 } });
  });

  it('honours the page size asked for, up to the ceiling of 100', async () => {
    expect(idsOf(await call('GET', listUrl(agencyA, '?pageSize=5'), 'pager'))).toEqual(expectedOrder.slice(0, 5));
    expect(idsOf(await call('GET', listUrl(agencyA, '?pageSize=5&page=3'), 'pager'))).toEqual(expectedOrder.slice(10, 15));
    const capped = await call('GET', listUrl(agencyA, '?pageSize=100000'), 'pager');
    expect(capped.json().meta).toEqual({ page: 1, pageSize: 100, totalItems: 45, totalPages: 1 });
    expect(idsOf(capped)).toEqual(expectedOrder);
  });

  it('answers a page past the end with no items and the total of the same filter, with and without unread=true', async () => {
    expect((await call('GET', listUrl(agencyA, '?page=4'), 'pager')).json()).toEqual({ data: [], meta: { page: 4, pageSize: 20, totalItems: 45, totalPages: 3 } });
    expect((await call('GET', listUrl(agencyA, '?unread=true&page=3'), 'pager')).json()).toEqual({ data: [], meta: { page: 3, pageSize: 20, totalItems: 30, totalPages: 2 } });
    expect((await call('GET', listUrl(agencyA, '?page=9007199254740991'), 'pager')).json().meta.totalItems).toBe(45);
  });

  it('shows another person the same query as theirs: an empty list, not the rows of this one', async () => {
    for (const as of ['rita', 'tom', 'owner', 'admin']) {
      const reply = await call('GET', listUrl(agencyA, '?pageSize=100'), as);
      expect({ as, ids: idsOf(reply) }).toEqual({ as, ids: [] });
    }
  });

  it.each([
    ['page=0'], ['page=-1'], ['page=1.5'], ['page=abc'], ['page='], ['page=1e20'], ['page=9007199254740992'], ['pageSize=0'], ['pageSize=-5'], ['pageSize=abc'],
    ['unread=false'], ['unread=1'], ['unread=TRUE'], ['unread='], ['unread=true&unread=true'], ['cursor=eyJpZCI6MX0'], ['offset=5'], ['recipient=someone'], ['q=x'], ['page[]=1']
  ])('refuses the query %s with 400 and no detail of the database, and never gives another person\'s rows', async (query) => {
    const reply = await call('GET', listUrl(agencyA, `?${query}`), 'pager');

    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    expect(reply.body).not.toMatch(NO_DATABASE_DETAIL);
  });
});

describe('what the database raises under the routes', () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ['42501', 403, 'FORBIDDEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN'],
    ['22P02', 404, 'NOT_FOUND'],
    ['A0042', 404, 'NOT_FOUND']
  ];

  it.each(cases)('answers %s with %i %s on the four routes, with no detail of the database', async (code, status, errorCode) => {
    const { ids } = await seedTheTeam();
    injected = { code };

    for (const route of everyRoute(agencyA, ids.approved)) {
      const reply = await call(route.method, route.url, 'rita');
      expect({ route: route.name, status: reply.statusCode, code: reply.json().error.code }).toEqual({ route: route.name, status, code: errorCode });
      expect({ route: route.name, leaked: NO_DATABASE_DETAIL.test(reply.json().error.message) }).toEqual({ route: route.name, leaked: false });
    }
    injected = undefined;
    expect(await unreadOf(users.rita!.id)).toBe(4);
  });

  it('keeps an unexpected failure a 500 with the generic message, so nothing unmapped is hidden as a 4xx', async () => {
    injected = { code: 'XX000' };
    const reply = await call('GET', listUrl(agencyA), 'rita');
    expect(reply.statusCode).toBe(500);
    expect(reply.json().error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  describe('inside the functions that write', () => {
    // A trigger plays what the database may raise at the UPDATE of the function: the whole statement is undone with it.
    const withFailingUpdate = async (errcode: string, run: () => Promise<void>): Promise<void> => {
      const name = `zz_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await owner.knex.raw(`
        create function public.${name}() returns trigger language plpgsql as $$
        begin
          raise exception 'injected failure' using errcode = '${errcode}';
        end $$;
        create trigger ${name} before update on public.notifications for each row execute function public.${name}();
      `);
      try {
        await run();
      } finally {
        await owner.knex.raw(`drop trigger if exists ${name} on public.notifications; drop function if exists public.${name}();`);
      }
    };

    it.each(cases)('answers %s with %i %s from the update of read and of read-all, and leaves every notification unread', async (code, status, errorCode) => {
      const { ids } = await seedTheTeam();
      await withFailingUpdate(code, async () => {
        for (const [name, reply] of [
          ['read', await call('POST', readUrl(agencyA, ids.approved), 'rita')],
          ['read-all', await call('POST', readAllUrl(agencyA), 'rita')]
        ] as const) {
          expect({ name, status: reply.statusCode, code: reply.json().error.code }).toEqual({ name, status, code: errorCode });
          expect(reply.body).not.toMatch(NO_DATABASE_DETAIL);
        }
      });
      expect(await unreadOf(users.rita!.id)).toBe(4);
      expect(await readAtOf(ids.approved)).toBeNull();
    });
  });
});

describe('the unread count', () => {
  it('counts what is unread now and drops as the person reads, never below zero', async () => {
    const { ids } = await seedTheTeam();
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 4 } });

    await call('POST', readUrl(agencyA, ids.changes), 'rita');
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 3 } });
    await call('POST', readAllUrl(agencyA), 'rita');
    expect((await call('GET', countUrl(agencyA), 'rita')).json()).toEqual({ data: { count: 0 } });
  });
});
