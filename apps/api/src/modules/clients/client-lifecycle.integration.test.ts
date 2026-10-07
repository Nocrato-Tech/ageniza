import { createHash, randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
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

// Issues #131 and #133 (the route half). `status`, `archived_at` and `closing_date` are out of every
// grant of `ageniza_app`, so what these routes do is exactly what `app_private.set_client_closing_date`,
// `archive_client` and `reactivate_client` do, and what the daily job does is `archive_due_clients`.
// Every permission is held alone by a custom role, every race is two real transactions, and the
// portal is probed with the four kinds of person who can reach it: a person with only a client link,
// a collaborator with a client link (`dual`), one whose role holds no `cliente.*` key at all
// (`dualBare`) and an Admin of another agency with a link here (`crossDual`).
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdCustomRoleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const cMain = randomUUID();
const cOtherPortal = randomUUID();
const cOtherInAgency = randomUUID();
const cClosing = randomUUID();
const cForbidden = randomUUID();
const cSingle = randomUUID();
const cOwnerOnly = randomUUID();
const cParity = randomUUID();
const cJob = randomUUID();
const cNameActive = randomUUID();
const cNameArchived = randomUUID();
const cRaceOne = randomUUID();
const cRaceTwo = randomUUID();
const cRaceArchive = randomUUID();
const cRaceResend = randomUUID();
const cInB = randomUUID();
const cNoClosing = randomUUID();

const threadMain = randomUUID();

const sessionCookieHeader = (cookiesList: readonly { name: string; value: string }[]): string =>
  cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture, remoteAddress?: string): Promise<string> => {
  const response = await app.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: origin,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    payload: { email: user.email, password: user.password }
  });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `lifecycle-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const call = async (method: Method, url: string, cookie?: string, payload?: unknown, remoteAddress?: string): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const clientUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}`;
const closingUrl = (clientId: string, agencyId = agencyA): string => `${clientUrl(agencyId, clientId)}/closing`;
const archiveUrl = (clientId: string, agencyId = agencyA): string => `${clientUrl(agencyId, clientId)}/archive`;
const reactivateUrl = (clientId: string, agencyId = agencyA): string => `${clientUrl(agencyId, clientId)}/reactivate`;
const invitationsUrl = (clientId: string): string => `${clientUrl(agencyA, clientId)}/invitations`;

const CLIENT_KEYS = [
  'archivedAt', 'closingDate', 'contactEmail', 'contactName', 'contactPhone', 'id', 'instagramHandle', 'legalName',
  'name', 'photoUrl', 'segment', 'status', 'taxId', 'website'
];

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000);

/** The Brasília day, asked of the database that applies the rule, so the test never reads its own clock. */
const brasiliaDay = async (offsetDays = 0): Promise<string> => {
  const result = await raw<{ rows: readonly { day: string }[] }>(
    owner.knex,
    "select (((now() at time zone 'America/Sao_Paulo')::date) + ?::int)::text as day",
    [offsetDays]
  );
  return result.rows[0]!.day;
};

const clientRow = async (clientId: string): Promise<Record<string, unknown>> => {
  const row = await owner.knex('clients').where({ id: clientId }).first();
  if (row === undefined) throw new Error(`No client ${clientId}.`);
  return row as Record<string, unknown>;
};

const closingOf = async (clientId: string): Promise<string | null> =>
  (await owner.knex('clients').where({ id: clientId }).select(owner.knex.raw('closing_date::text as closing_date')).first()).closing_date as string | null;

const auditActions = async (clientId: string): Promise<{ action: string; actor_user_id: string | null; agency_id: string | null; request_id: string | null }[]> =>
  owner.knex('audit.events').where({ target_type: 'client', target_id: clientId }).orderBy('occurred_at', 'asc').select('action', 'actor_user_id', 'agency_id', 'request_id');

const seedInvitation = async (input: {
  readonly purpose: 'client_invite' | 'collaborator_invite';
  readonly clientId?: string;
  readonly email: string;
  readonly expiresAt?: Date;
  readonly usedAt?: Date;
  readonly revokedAt?: Date;
}): Promise<string> => {
  const id = randomUUID();
  const productionRole = (await owner.knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id')).id as string;
  await owner.knex('invitations').insert({
    id,
    agency_id: agencyA,
    purpose: input.purpose,
    email: input.email,
    client_id: input.clientId ?? null,
    role_id: input.purpose === 'collaborator_invite' ? productionRole : null,
    token_hash: hash(`${id}:token`),
    expires_at: input.expiresAt ?? daysFromNow(7),
    used_at: input.usedAt ?? null,
    revoked_at: input.revokedAt ?? null
  });
  return id;
};

const revokedAtOf = async (invitationId: string): Promise<Date | null> =>
  (await owner.knex('invitations').where({ id: invitationId }).first('revoked_at')).revoked_at as Date | null;

const PORTAL_PEOPLE = ['portalOne', 'dual', 'dualBare', 'crossDual'] as const;

const linkPortalPeople = async (clientId: string): Promise<void> => {
  await owner.knex('client_memberships').insert(PORTAL_PEOPLE.map((key) => ({ client_id: clientId, user_id: users[key]!.id })));
};

const insertClient = async (id: string, name: string, extra: Record<string, unknown> = {}, agencyId = agencyA): Promise<void> => {
  await owner.knex('clients').insert({ id, agency_id: agencyId, name, ...extra });
};

/** Every route a person of the portal can reach for a client, with a body that would be accepted. */
const portalProbes = (clientId: string): readonly { readonly label: string; readonly method: Method; readonly url: string; readonly payload?: unknown }[] => [
  { label: 'client', method: 'GET', url: `/clients/${clientId}` },
  { label: 'brand study', method: 'GET', url: `/clients/${clientId}/brand-study` },
  { label: 'threads', method: 'GET', url: `/clients/${clientId}/threads?sectionKey=branding` },
  { label: 'open thread', method: 'POST', url: `/clients/${clientId}/threads`, payload: { subject: { sectionKey: 'branding' }, body: 'Posso sugerir uma mudança?' } },
  { label: 'comments', method: 'GET', url: `/clients/${clientId}/threads/${threadMain}/comments` },
  { label: 'comment', method: 'POST', url: `/clients/${clientId}/threads/${threadMain}/comments`, payload: { body: 'Mais uma ideia.' } },
  { label: 'tour', method: 'POST', url: `/clients/${clientId}/onboarding/seen` }
];

const expectPortalClosed = async (clientId: string, people: readonly string[] = PORTAL_PEOPLE): Promise<void> => {
  for (const key of people) {
    for (const probe of portalProbes(clientId)) {
      const response = await call(probe.method, probe.url, cookies[key], probe.payload);
      expect(response.statusCode, `${key} ${probe.label}`).toBe(404);
      expect(response.json().error.code, `${key} ${probe.label}`).toBe('NOT_FOUND');
    }
  }
};

const expectPortalOpen = async (clientId: string, people: readonly string[] = PORTAL_PEOPLE): Promise<void> => {
  for (const key of people) {
    const response = await call('GET', `/clients/${clientId}`, cookies[key]);
    expect(response.statusCode, key).toBe(200);
    expect(response.json().id, key).toBe(clientId);
  }
};

const contextClientIds = async (cookie: string): Promise<string[]> => {
  const response = await call('GET', '/me/contexts', cookie);
  expect(response.statusCode).toBe(200);
  return response.json().contexts.filter((context: { type: string }) => context.type === 'client').map((context: { clientId: string }) => context.clientId);
};

const membershipSnapshot = async (clientId: string): Promise<unknown[]> =>
  owner.knex('client_memberships').where({ client_id: clientId }).orderBy('user_id').select('id', 'user_id', 'status', 'created_at');

/** What archiving does, whichever path did it: the same columns, with the actor and origin set apart. */
const archiveEffects = async (clientId: string, invitationIds: readonly string[]) => {
  const row = await clientRow(clientId);
  return {
    status: row.status,
    archivedAtSet: row.archived_at !== null,
    closingDate: await closingOf(clientId),
    revoked: await Promise.all(invitationIds.map(async (id) => (await revokedAtOf(id)) !== null)),
    memberships: (await membershipSnapshot(clientId)).length,
    activeMemberships: Number((await owner.knex('client_memberships').where({ client_id: clientId, status: 'active' }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0),
    events: (await auditActions(clientId)).map((event) => ({ action: event.action, agencyId: event.agency_id }))
  };
};

type Holder = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const backendPid = async (transaction: Holder): Promise<number> => {
  const result = await raw<{ rows: Array<{ pid: number }> }>(transaction, 'select pg_catalog.pg_backend_pid() as pid', []);
  return Number(result.rows[0]?.pid);
};

/** Waits until a backend of this database is blocked by the given one, so the race is sequenced by locks and never by a sleep. */
const waitForBackendBlockedBy = async (blockerPid: number): Promise<number> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ pid: number }> }>(owner.knex, `
      select activity.pid
      from pg_catalog.pg_stat_activity activity
      where activity.datname = pg_catalog.current_database()
        and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
      limit 1
    `, [blockerPid]);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend ever waited on a lock held by ${blockerPid}.`);
};

const NO_DATABASE_DETAIL = /deadlock|40P01|pg_|relation|process|A002/i;

describe('CLIENTS contract lifecycle, agency side (#131)', () => {
  const invitations: Record<string, string> = {};

  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['manager', 'Marta Gestora'], ['production', 'Paulo Produção'], ['sales', 'Vera Vendas'],
      ['finance', 'Fábio Financeiro'], ['ownerUser', 'Dona da Agência'], ['archiveOnly', 'Só Arquiva'], ['operateOnly', 'Só Opera'],
      ['racer', 'Admin da Corrida'], ['otherAdmin', 'Admin da Outra'],
      ['portalOne', 'Pessoa do Portal'], ['dual', 'Duda Dupla'], ['dualBare', 'Eva Dupla Sem Papel'], ['crossDual', 'Admin da Outra com Vínculo']
    ] as const) await makeUser(key, name);

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Ciclo Agency A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Ciclo Agency B', owner_user_id: null }
    ]);

    // Custom roles holding ONE permission each: the Admin holds them all and hides a guard with the wrong key.
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdCustomRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };
    const archiveOnlyRole = await customRole('cliente.arquivar');
    const operateOnlyRole = await customRole('cliente.operar');
    const unrelatedRole = await customRole('midia.enviar');

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.production!.id, role_id: roleId('production') },
      { agency_id: agencyA, user_id: users.sales!.id, role_id: roleId('sales') },
      { agency_id: agencyA, user_id: users.finance!.id, role_id: roleId('finance') },
      { agency_id: agencyA, user_id: users.archiveOnly!.id, role_id: archiveOnlyRole },
      { agency_id: agencyA, user_id: users.operateOnly!.id, role_id: operateOnlyRole },
      { agency_id: agencyA, user_id: users.racer!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: unrelatedRole },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') }
    ]);

    await insertClient(cMain, `Ciclo Principal ${cMain}`);
    await insertClient(cOtherPortal, `Ciclo Outro Portal ${cOtherPortal}`);
    await insertClient(cOtherInAgency, `Ciclo Vizinho ${cOtherInAgency}`);
    await insertClient(cClosing, `Ciclo Encerramento ${cClosing}`);
    await insertClient(cForbidden, `Ciclo Proibido ${cForbidden}`, { closing_date: await brasiliaDay(30) });
    await insertClient(cSingle, `Ciclo Uma Permissão ${cSingle}`);
    await insertClient(cOwnerOnly, `Ciclo Dona ${cOwnerOnly}`);
    await insertClient(cParity, `Ciclo Paridade ${cParity}`);
    await insertClient(cNameActive, `Ciclo  Homônimo ${cNameActive.slice(0, 8)}`);
    await insertClient(cNameArchived, `ciclo homônimo ${cNameActive.slice(0, 8)}`, { status: 'archived', archived_at: new Date() });
    await insertClient(cRaceOne, `Ciclo Corrida ${cNameActive.slice(0, 8)}`, { status: 'archived', archived_at: new Date() });
    await insertClient(cRaceTwo, `ciclo  corrida ${cNameActive.slice(0, 8)}`, { status: 'archived', archived_at: new Date() });
    await insertClient(cRaceArchive, `Ciclo Disputa Arquivar ${cRaceArchive}`);
    await insertClient(cRaceResend, `Ciclo Disputa Reenviar ${cRaceResend}`);
    await insertClient(cNoClosing, `Ciclo Sem Data ${cNoClosing}`);
    await insertClient(cInB, `Ciclo Agência B ${cInB}`, { closing_date: await brasiliaDay(30) }, agencyB);

    await linkPortalPeople(cMain);
    await linkPortalPeople(cParity);
    await linkPortalPeople(cClosing);
    await owner.knex('client_memberships').insert([
      { client_id: cOtherPortal, user_id: users.portalOne!.id },
      { client_id: cOtherInAgency, user_id: users.dual!.id }
    ]);

    await owner.knex('client_brand_sections').insert({ client_id: cMain, section_key: 'branding', body: 'Marca acolhedora.', updated_by: users.admin!.id });
    await owner.knex('client_threads').insert({ id: threadMain, client_id: cMain, section_key: 'branding', opened_by: users.portalOne!.id, opened_side: 'client' });
    await owner.knex('client_thread_comments').insert({ thread_id: threadMain, client_id: cMain, author_user_id: users.portalOne!.id, author_side: 'client', body: 'Primeira ideia.' });

    // The invitations of cMain: two that are pending (one of them already expired but never revoked),
    // and the ones that archiving must leave alone because they are not pending, not portal or not its.
    invitations.pendingOne = await seedInvitation({ purpose: 'client_invite', clientId: cMain, email: 'um@ciclo.test' });
    invitations.pendingTwo = await seedInvitation({ purpose: 'client_invite', clientId: cMain, email: 'dois@ciclo.test', expiresAt: new Date(Date.now() - 3600_000) });
    invitations.used = await seedInvitation({ purpose: 'client_invite', clientId: cMain, email: 'aceito@ciclo.test', usedAt: new Date(Date.now() - 86_400_000) });
    invitations.alreadyRevoked = await seedInvitation({ purpose: 'client_invite', clientId: cMain, email: 'revogado@ciclo.test', revokedAt: new Date(Date.now() - 86_400_000) });
    invitations.collaborator = await seedInvitation({ purpose: 'collaborator_invite', email: 'colaborador@ciclo.test' });
    invitations.otherClient = await seedInvitation({ purpose: 'client_invite', clientId: cOtherInAgency, email: 'vizinho@ciclo.test' });
    invitations.parityOne = await seedInvitation({ purpose: 'client_invite', clientId: cParity, email: 'paridade@ciclo.test' });
    invitations.raceArchive = await seedInvitation({ purpose: 'client_invite', clientId: cRaceArchive, email: 'corrida-arquivar@ciclo.test' });
    invitations.raceResend = await seedInvitation({ purpose: 'client_invite', clientId: cRaceResend, email: 'corrida-reenviar@ciclo.test' });

    for (const key of ['admin', 'manager', 'production', 'sales', 'finance', 'ownerUser', 'archiveOnly', 'operateOnly', 'otherAdmin', 'portalOne', 'dual', 'dualBare', 'crossDual']) {
      cookies[key] = await login(users[key]!);
    }
    cookies.racer = await login(users.racer!, '127.0.0.31');
  });

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('client_brand_sections').whereIn('client_id', clientIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
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

  describe('who may change the contract', () => {
    const lifecycleCalls = (clientId: string): readonly { readonly label: string; readonly method: Method; readonly url: string; readonly payload?: unknown }[] => [
      { label: 'schedule', method: 'PUT', url: closingUrl(clientId), payload: { closingDate: '2099-12-31' } },
      { label: 'clear', method: 'DELETE', url: closingUrl(clientId) },
      { label: 'archive', method: 'POST', url: archiveUrl(clientId) },
      { label: 'reactivate', method: 'POST', url: reactivateUrl(clientId) }
    ];

    it('answers 403 to every preset but the Admin and to a role that holds only cliente.operar, on all four routes, changing nothing', async () => {
      const before = await clientRow(cForbidden);
      const auditBefore = await auditActions(cForbidden);

      for (const key of ['manager', 'production', 'sales', 'finance', 'operateOnly']) {
        for (const probe of lifecycleCalls(cForbidden)) {
          const response = await call(probe.method, probe.url, cookies[key], probe.payload);
          expect(response.statusCode, `${key} ${probe.label}`).toBe(403);
          expect(response.json().error.code, `${key} ${probe.label}`).toBe('FORBIDDEN');
        }
      }

      expect(await clientRow(cForbidden)).toEqual(before);
      expect(await auditActions(cForbidden)).toEqual(auditBefore);
    });

    it('answers 401 without a session and 403 to a CSRF-less call before touching anything', async () => {
      const before = await clientRow(cForbidden);
      for (const probe of lifecycleCalls(cForbidden)) {
        const anonymous = await call(probe.method, probe.url, undefined, probe.payload);
        expect(anonymous.statusCode, probe.label).toBe(401);
        const noOrigin = await app.app.inject({ method: probe.method, url: probe.url, headers: { cookie: cookies.admin! }, ...(probe.payload === undefined ? {} : { payload: probe.payload as Record<string, unknown> }) });
        expect(noOrigin.statusCode, probe.label).toBe(403);
        expect(noOrigin.json().error.code, probe.label).toBe('CSRF_REJECTED');
      }
      expect(await clientRow(cForbidden)).toEqual(before);
    });

    it('lets a role that holds only cliente.arquivar schedule, clear, archive and reactivate', async () => {
      const closingDate = await brasiliaDay(10);
      const scheduled = await call('PUT', closingUrl(cSingle), cookies.archiveOnly, { closingDate });
      expect(scheduled.statusCode).toBe(200);
      expect(scheduled.json()).toMatchObject({ id: cSingle, status: 'active', closingDate });

      const cleared = await call('DELETE', closingUrl(cSingle), cookies.archiveOnly);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ status: 'active', closingDate: null });

      const archived = await call('POST', archiveUrl(cSingle), cookies.archiveOnly);
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ status: 'archived', closingDate: null });
      expect(archived.json().archivedAt).toEqual(expect.any(String));

      const reactivated = await call('POST', reactivateUrl(cSingle), cookies.archiveOnly);
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json()).toMatchObject({ status: 'active', archivedAt: null });
    });

    it('lets the Owner, who holds no role, do the same, and records who acted', async () => {
      const closingDate = await brasiliaDay(5);
      expect((await call('PUT', closingUrl(cOwnerOnly), cookies.ownerUser, { closingDate })).statusCode).toBe(200);
      expect((await call('DELETE', closingUrl(cOwnerOnly), cookies.ownerUser)).statusCode).toBe(200);
      expect((await call('POST', archiveUrl(cOwnerOnly), cookies.ownerUser)).statusCode).toBe(200);
      expect((await call('POST', reactivateUrl(cOwnerOnly), cookies.ownerUser)).statusCode).toBe(200);

      const events = await auditActions(cOwnerOnly);
      expect(events.map((event) => event.action)).toEqual(['client.closing_scheduled', 'client.closing_cleared', 'client.archived', 'client.reactivated']);
      for (const event of events) expect(event).toMatchObject({ actor_user_id: users.ownerUser!.id, agency_id: agencyA });
    });

    it('answers 404, changing nothing, to an Admin of another agency, on the other agency\'s path and on their own', async () => {
      const before = await clientRow(cForbidden);
      for (const agencyId of [agencyA, agencyB]) {
        for (const probe of lifecycleCalls(cForbidden)) {
          const url = probe.url.replace(`/agencies/${agencyA}/`, `/agencies/${agencyId}/`);
          const response = await call(probe.method, url, cookies.otherAdmin, probe.payload);
          expect(response.statusCode, `${agencyId} ${probe.label}`).toBe(404);
        }
      }
      expect(await clientRow(cForbidden)).toEqual(before);

      // Their own agency's client through the routes of the other: the client is not in that agency.
      const beforeB = await clientRow(cInB);
      for (const probe of lifecycleCalls(cInB)) {
        const url = probe.url.replace(`/agencies/${agencyA}/`, `/agencies/${agencyA}/`);
        const response = await call(probe.method, url, cookies.admin, probe.payload);
        expect(response.statusCode, `admin A on a client of B, ${probe.label}`).toBe(404);
      }
      expect(await clientRow(cInB)).toEqual(beforeB);
    });

    it('answers the same 404 to an unknown id and to an id that is not a UUID', async () => {
      for (const clientId of [randomUUID(), 'not-a-uuid', '00000000-0000-0000-0000-000000000000', `${cMain}x`]) {
        for (const probe of lifecycleCalls(cMain)) {
          const url = probe.url.replace(cMain, clientId);
          const response = await call(probe.method, url, cookies.admin, probe.payload);
          expect(response.statusCode, `${clientId} ${probe.label}`).toBe(404);
          expect(response.json().error.code, `${clientId} ${probe.label}`).toBe('NOT_FOUND');
        }
      }
    });
  });

  describe('PUT and DELETE .../closing', () => {
    it('refuses yesterday with 400 and changes nothing', async () => {
      const yesterday = await brasiliaDay(-1);
      const response = await call('PUT', closingUrl(cClosing), cookies.admin, { closingDate: yesterday });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { issues: [expect.objectContaining({ path: 'closingDate' })] }
      });
      expect(JSON.stringify(response.json())).not.toMatch(NO_DATABASE_DETAIL);
      expect(await closingOf(cClosing)).toBeNull();
      expect(await auditActions(cClosing)).toEqual([]);
    });

    it('accepts today: the client stays active, the portal stays open, and the daily job leaves it alone', async () => {
      const today = await brasiliaDay();
      const response = await call('PUT', closingUrl(cClosing), cookies.admin, { closingDate: today });
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(CLIENT_KEYS);
      expect(response.json()).toMatchObject({ id: cClosing, status: 'active', closingDate: today, archivedAt: null });
      expect(await closingOf(cClosing)).toBe(today);

      await expectPortalOpen(cClosing);

      // The contract runs through the end of the 30th: today is not past, so the job archives nothing of this client.
      await raw(app.database.knex, 'select app_private.archive_due_clients()', []);
      expect(await clientRow(cClosing)).toMatchObject({ status: 'active', archived_at: null });
      expect(await closingOf(cClosing)).toBe(today);
      await expectPortalOpen(cClosing);
    });

    it('replaces the date by scheduling again, and records one event per change', async () => {
      const later = await brasiliaDay(40);
      const response = await call('PUT', closingUrl(cClosing), cookies.admin, { closingDate: later });
      expect(response.statusCode).toBe(200);
      expect(response.json().closingDate).toBe(later);
      expect(await closingOf(cClosing)).toBe(later);
      expect((await auditActions(cClosing)).map((event) => event.action)).toEqual(['client.closing_scheduled', 'client.closing_scheduled']);
    });

    it('refuses a body that is not exactly a real day, with 400 and no change', async () => {
      const before = await closingOf(cClosing);
      for (const payload of [
        {}, { closingDate: null }, { closingDate: '' }, { closingDate: '2099-02-30' }, { closingDate: '31/12/2099' },
        { closingDate: '2099-12-31T00:00:00Z' }, { closingDate: 20991231 }, { closingDate: '2099-12-31', status: 'archived' },
        { closingDate: '2099-12-31', archivedAt: '2099-12-31T00:00:00Z' }, []
      ]) {
        const response = await call('PUT', closingUrl(cClosing), cookies.admin, payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(JSON.stringify(response.json())).not.toMatch(NO_DATABASE_DETAIL);
      }
      // Declared as JSON and empty, or a JSON string, or not JSON at all: 400 or 415, never a 500 and never an echo of the body.
      for (const [body, contentType] of [[undefined, 'application/json'], ['"texto"', 'application/json'], ['{"closingDate":', 'application/json'], ['2099-12-31', 'text/plain']] as const) {
        const response = await app.app.inject({
          method: 'PUT',
          url: closingUrl(cClosing),
          headers: { ...origin, cookie: cookies.admin!, 'content-type': contentType },
          ...(body === undefined ? {} : { body })
        });
        expect([400, 415], `${contentType} ${String(body)}`).toContain(response.statusCode);
        expect(response.body).not.toContain('texto');
      }
      expect(await closingOf(cClosing)).toBe(before);
    });

    it('clears the date, and answers 409 when there is none to clear', async () => {
      const cleared = await call('DELETE', closingUrl(cClosing), cookies.admin);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ id: cClosing, status: 'active', closingDate: null });
      expect(await closingOf(cClosing)).toBeNull();

      const again = await call('DELETE', closingUrl(cClosing), cookies.admin);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toEqual({ code: 'CLOSING_DATE_NOT_SET', message: 'Este cliente não tem encerramento agendado.' });

      const never = await call('DELETE', closingUrl(cNoClosing), cookies.admin);
      expect(never.statusCode).toBe(409);
      expect(never.json().error.code).toBe('CLOSING_DATE_NOT_SET');

      // Two events for the one real clear; the refusal wrote nothing.
      expect((await auditActions(cClosing)).map((event) => event.action)).toEqual(['client.closing_scheduled', 'client.closing_scheduled', 'client.closing_cleared']);
      expect(await auditActions(cNoClosing)).toEqual([]);
    });

    it('is out of reach of the registration PATCH, in the route and in the grant', async () => {
      await call('PUT', closingUrl(cClosing), cookies.admin, { closingDate: await brasiliaDay(20) });
      const before = await clientRow(cClosing);

      for (const payload of [{ closingDate: '2099-01-01' }, { closingDate: null }, { status: 'archived' }, { archivedAt: '2099-01-01T00:00:00Z' }, { name: 'Novo nome', closingDate: '2099-01-01' }]) {
        const response = await call('PATCH', clientUrl(agencyA, cClosing), cookies.admin, payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(await clientRow(cClosing)).toEqual(before);

      // The route is one barrier; the grant is the other. A role that may edit the registration still cannot write the columns.
      for (const column of ['closing_date', 'status', 'archived_at'] as const) {
        const value = column === 'closing_date' ? '2099-01-01' : column === 'status' ? 'archived' : new Date();
        await expect(withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: users.manager!.id }), (transaction) =>
          raw(transaction, `update public.clients set ${column} = ? where id = ?::uuid`, [value, cClosing])
        ), column).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
      }
      expect(await clientRow(cClosing)).toEqual(before);
      await call('DELETE', closingUrl(cClosing), cookies.admin);
    });
  });

  describe('POST .../archive', () => {
    it('shows the portal open, the invitations pending and the people linked before it archives', async () => {
      await expectPortalOpen(cMain);
      const pending = await call('GET', invitationsUrl(cMain), cookies.admin);
      expect(pending.statusCode).toBe(200);
      expect(pending.json().data.map((item: { invitationId: string }) => item.invitationId)).toEqual([invitations.pendingOne]);
      expect(await contextClientIds(cookies.portalOne!)).toEqual(expect.arrayContaining([cMain, cOtherPortal]));
    });

    it('archives now: the client, its pending invitations, its portal and nothing else', async () => {
      await call('PUT', closingUrl(cMain), cookies.admin, { closingDate: await brasiliaDay(15) });
      const membershipsBefore = await membershipSnapshot(cMain);
      const usedBefore = await revokedAtOf(invitations.used);
      const alreadyRevokedBefore = await revokedAtOf(invitations.alreadyRevoked);

      const response = await call('POST', archiveUrl(cMain), cookies.admin);
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(CLIENT_KEYS);
      expect(response.json()).toMatchObject({ id: cMain, status: 'archived', closingDate: null });
      expect(Date.parse(response.json().archivedAt)).not.toBeNaN();
      expect(await clientRow(cMain)).toMatchObject({ status: 'archived', archived_at: expect.any(Date) });
      expect(await closingOf(cMain)).toBeNull();

      // The pending portal invitations of this client are revoked, the expired one included; no other is touched.
      expect(await revokedAtOf(invitations.pendingOne)).toBeInstanceOf(Date);
      expect(await revokedAtOf(invitations.pendingTwo)).toBeInstanceOf(Date);
      expect(await revokedAtOf(invitations.used)).toEqual(usedBefore);
      expect(await revokedAtOf(invitations.alreadyRevoked)).toEqual(alreadyRevokedBefore);
      expect(await revokedAtOf(invitations.collaborator)).toBeNull();
      expect(await revokedAtOf(invitations.otherClient)).toBeNull();
      expect((await call('GET', invitationsUrl(cMain), cookies.admin)).json().data).toEqual([]);
      expect((await call('GET', invitationsUrl(cOtherInAgency), cookies.admin)).json().data).toHaveLength(1);

      // The links stay as they were, so reactivating can give the access back.
      expect(await membershipSnapshot(cMain)).toEqual(membershipsBefore);

      const events = await auditActions(cMain);
      expect(events.filter((event) => event.action === 'client.archived')).toEqual([
        { action: 'client.archived', actor_user_id: users.admin!.id, agency_id: agencyA, request_id: null }
      ]);
    });

    it('closes the portal for the next request, whoever reaches it: a person, a collaborator with a link, a role with no cliente key, an Admin of another agency', async () => {
      await expectPortalClosed(cMain);
      const portalOneClients = await contextClientIds(cookies.portalOne!);
      expect(portalOneClients).not.toContain(cMain);
      expect(portalOneClients).toContain(cOtherPortal);
      expect(await contextClientIds(cookies.crossDual!)).not.toContain(cMain);
      for (const key of ['dual', 'dualBare']) expect(await contextClientIds(cookies[key]!), key).not.toContain(cMain);
    });

    it('stays readable to the agency, which sees an archived client and not an unreadable one', async () => {
      const detail = await call('GET', clientUrl(agencyA, cMain), cookies.admin);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ status: 'archived' });
      // The collaborator who also has a link reads through the agency, not through the portal.
      expect((await call('GET', clientUrl(agencyA, cMain), cookies.dual)).statusCode).toBe(200);
      expect((await call('GET', `${clientUrl(agencyA, cMain)}/members`, cookies.admin)).statusCode).toBe(200);
    });

    it('is read-only from then on: scheduling, clearing and archiving again answer 409, and the registration PATCH too', async () => {
      const before = await clientRow(cMain);
      const eventsBefore = await auditActions(cMain);
      const refused = [
        await call('PUT', closingUrl(cMain), cookies.admin, { closingDate: await brasiliaDay(20) }),
        await call('DELETE', closingUrl(cMain), cookies.admin),
        await call('POST', archiveUrl(cMain), cookies.admin),
        await call('PATCH', clientUrl(agencyA, cMain), cookies.admin, { segment: 'Novo' })
      ];
      for (const response of refused) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
      }
      expect(refused[0]!.json().error.message).toBe('Cliente arquivado: a única ação possível é reativar.');
      expect(await clientRow(cMain)).toEqual(before);
      expect(await auditActions(cMain)).toEqual(eventsBefore);
    });

    it('refuses to invite a person to an archived client, so no invitation outlives the archive', async () => {
      const response = await call('POST', invitationsUrl(cMain), cookies.admin, { email: 'novo@ciclo.test' });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('CLIENT_ARCHIVED');
      expect((await call('GET', invitationsUrl(cMain), cookies.admin)).json().data).toEqual([]);
    });
  });

  describe('POST .../reactivate', () => {
    it('gives the portal back to whoever had a link, with no new invitation and the revoked ones still revoked', async () => {
      const invitationRowsBefore = await owner.knex('invitations').where({ client_id: cMain }).count<{ count: string }[]>('id as count');
      const membershipsBefore = await membershipSnapshot(cMain);

      const response = await call('POST', reactivateUrl(cMain), cookies.admin);
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json()).sort()).toEqual(CLIENT_KEYS);
      expect(response.json()).toMatchObject({ id: cMain, status: 'active', archivedAt: null, closingDate: null });
      expect(await clientRow(cMain)).toMatchObject({ status: 'active', archived_at: null });

      await expectPortalOpen(cMain);
      expect(await contextClientIds(cookies.portalOne!)).toEqual(expect.arrayContaining([cMain, cOtherPortal]));
      expect(await membershipSnapshot(cMain)).toEqual(membershipsBefore);
      expect(await owner.knex('invitations').where({ client_id: cMain }).count<{ count: string }[]>('id as count')).toEqual(invitationRowsBefore);
      expect(await revokedAtOf(invitations.pendingOne)).toBeInstanceOf(Date);
      expect((await call('GET', invitationsUrl(cMain), cookies.admin)).json().data).toEqual([]);

      const events = await auditActions(cMain);
      expect(events.filter((event) => event.action === 'client.reactivated')).toEqual([
        { action: 'client.reactivated', actor_user_id: users.admin!.id, agency_id: agencyA, request_id: null }
      ]);
    });

    it('answers 409 for a client that is already active, writing nothing', async () => {
      const before = await clientRow(cMain);
      const eventsBefore = await auditActions(cMain);
      const response = await call('POST', reactivateUrl(cMain), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toEqual({ code: 'CLIENT_NOT_ARCHIVED', message: 'Este cliente já está ativo.' });
      expect(await clientRow(cMain)).toEqual(before);
      expect(await auditActions(cMain)).toEqual(eventsBefore);
    });

    it('answers 409 with the name message when an active client uses the name, however it is spelled, and the client stays archived', async () => {
      const before = await clientRow(cNameArchived);
      const response = await call('POST', reactivateUrl(cNameArchived), cookies.admin);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toEqual({
        code: 'CLIENT_NAME_IN_USE',
        message: 'Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.'
      });
      expect(JSON.stringify(response.json())).not.toMatch(NO_DATABASE_DETAIL);
      expect(await clientRow(cNameArchived)).toEqual(before);
      expect(await clientRow(cNameArchived)).toMatchObject({ status: 'archived' });

      // Renaming one of the two is the way out.
      const renamed = await call('PATCH', clientUrl(agencyA, cNameActive), cookies.admin, { name: `Ciclo Renomeado ${cNameActive}` });
      expect(renamed.statusCode).toBe(200);
      const retried = await call('POST', reactivateUrl(cNameArchived), cookies.admin);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({ id: cNameArchived, status: 'active', archivedAt: null });
    });

    it('lets exactly one of two archived homonyms come back when both are reactivated at once', async () => {
      const responses = await Promise.all([
        call('POST', reactivateUrl(cRaceOne), cookies.admin),
        call('POST', reactivateUrl(cRaceTwo), cookies.admin)
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const loser = responses.find((response) => response.statusCode === 409)!;
      expect(loser.json().error.code).toBe('CLIENT_NAME_IN_USE');
      expect(JSON.stringify(loser.json())).not.toMatch(NO_DATABASE_DETAIL);

      const rows = await owner.knex('clients').whereIn('id', [cRaceOne, cRaceTwo]).select('id', 'status');
      expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'archived')).toHaveLength(1);
    });
  });

  describe('the daily job and the route have one effect', () => {
    it('archives a client the same way, and closes the portal the same way, as the route does', async () => {
      const ids = (names: readonly string[]) => names.map((name) => invitations[name]!);

      // The route's client has the same shape as the job's: a pending invitation and the four links.
      // The job's contract ended yesterday in Brasília. It is created here, not with the other fixtures,
      // because an earlier test runs the job and would have archived it.
      await insertClient(cJob, `Ciclo Job ${cJob}`, { closing_date: await brasiliaDay(-1) });
      await linkPortalPeople(cJob);
      invitations.jobOne = await seedInvitation({ purpose: 'client_invite', clientId: cJob, email: 'job@ciclo.test' });
      const routeResponse = await call('POST', archiveUrl(cParity), cookies.admin);
      expect(routeResponse.statusCode).toBe(200);

      const archivedBefore = await raw<{ rows: readonly { archived: number }[] }>(app.database.knex, 'select app_private.archive_due_clients() as archived', []);
      expect(Number(archivedBefore.rows[0]!.archived)).toBeGreaterThanOrEqual(1);

      const byRoute = await archiveEffects(cParity, ids(['parityOne']));
      const byJob = await archiveEffects(cJob, ids(['jobOne']));
      expect(byJob).toEqual(byRoute);
      expect(byJob).toMatchObject({ status: 'archived', archivedAtSet: true, closingDate: null, revoked: [true], memberships: 4, activeMemberships: 4 });

      // Only the actor and the origin tell the two apart.
      expect(await auditActions(cParity)).toEqual([{ action: 'client.archived', actor_user_id: users.admin!.id, agency_id: agencyA, request_id: null }]);
      expect(await auditActions(cJob)).toEqual([{ action: 'client.archived', actor_user_id: null, agency_id: agencyA, request_id: 'job:clients.archive-due' }]);

      await expectPortalClosed(cParity);
      await expectPortalClosed(cJob);
    });

    it('does nothing the second time, and the route then reactivates what the job archived', async () => {
      const second = await raw<{ rows: readonly { archived: number }[] }>(app.database.knex, 'select app_private.archive_due_clients() as archived', []);
      const eventsBefore = await auditActions(cJob);
      expect(Number(second.rows[0]!.archived)).toBe(0);
      expect(await auditActions(cJob)).toEqual(eventsBefore);

      const reactivated = await call('POST', reactivateUrl(cJob), cookies.admin);
      expect(reactivated.statusCode).toBe(200);
      await expectPortalOpen(cJob);
    });
  });

  describe('a race with the invitations of the same client', () => {
    it('answers 409 TRY_AGAIN, with no database detail and nothing changed, when the archive loses a deadlock with a resend, and works when repeated', async () => {
      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // The holder plays a resend that already holds the invitation. The archive locks the client and
        // then waits for that invitation; when the holder asks for the client, the two wait on each
        // other and the archive, which waited first, loses.
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitations.raceArchive]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
        const holderPid = await backendPid(holder);

        const archiving = call('POST', archiveUrl(cRaceArchive), cookies.racer, undefined, '127.0.0.31');
        await waitForBackendBlockedBy(holderPid);
        await holder.raw('select id from public.clients where id = ?::uuid for share', [cRaceArchive]);
        await holder.rollback();
        released = true;

        const response = await archiving;
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toEqual({ code: 'TRY_AGAIN', message: 'Houve um conflito momentâneo. Tente de novo.' });
        expect(JSON.stringify(response.json())).not.toMatch(NO_DATABASE_DETAIL);

        expect(await clientRow(cRaceArchive)).toMatchObject({ status: 'active', archived_at: null });
        expect(await revokedAtOf(invitations.raceArchive)).toBeNull();
        expect(await auditActions(cRaceArchive)).toEqual([]);

        const retried = await call('POST', archiveUrl(cRaceArchive), cookies.racer, undefined, '127.0.0.31');
        expect(retried.statusCode).toBe(200);
        expect(retried.json().status).toBe('archived');
        expect(await revokedAtOf(invitations.raceArchive)).toBeInstanceOf(Date);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 30_000);

    it('answers 409 TRY_AGAIN to the resend that loses the same deadlock to an archive, and leaves its invitation pending', async () => {
      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // The holder plays the archive: it holds the client, and the resend waits for the client with
        // the invitation row locked. When the holder revokes the client's invitations the cycle closes
        // and the resend, which waited first, loses.
        await raw(holder, 'select id from public.clients where id = ?::uuid for update', [cRaceResend]);
        const holderPid = await backendPid(holder);

        const resending = call('POST', `/agencies/${agencyA}/invitations/${invitations.raceResend}/resend`, cookies.racer, undefined, '127.0.0.31');
        await waitForBackendBlockedBy(holderPid);
        await holder.raw(
          "update public.invitations set revoked_at = now() where client_id = ?::uuid and purpose = 'client_invite' and used_at is null and revoked_at is null",
          [cRaceResend]
        );
        await holder.rollback();
        released = true;

        const response = await resending;
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('TRY_AGAIN');
        expect(JSON.stringify(response.json())).not.toMatch(NO_DATABASE_DETAIL);
        expect(await revokedAtOf(invitations.raceResend)).toBeNull();
        expect(await owner.knex('invitations').where({ client_id: cRaceResend }).select('id')).toHaveLength(1);
        expect(await clientRow(cRaceResend)).toMatchObject({ status: 'active' });
      } finally {
        if (!released) await holder.rollback();
      }
    }, 30_000);
  });
});
