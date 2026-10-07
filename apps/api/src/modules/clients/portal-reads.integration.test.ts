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

// Issue #129: the portal's reads of its own client. Row-level security says who may read a row, not
// from which side, so a collaborator who also has a client link reads through the agency branch of
// every policy. Every portal route is therefore driven by that person too (`dual`, an account
// manager; `dualBare`, a role with no `cliente.*` key at all) and by one who belongs to an agency
// and links to a client of another (`crossDual`).
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const agencySuspended = randomUUID();
const createdUserIds: string[] = [];
const createdCustomRoleIds: string[] = [];

const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const clientArchived = randomUUID();
const clientSuspended = randomUUID();
const clientEmpty = randomUUID();
const clientHome = randomUUID();

const personaActive = randomUUID();
const personaArchived = randomUUID();
const personaOfA2 = randomUUID();
const personaHomeActive = randomUUID();
const personaHomeArchived = randomUUID();

const AGENCY_A_NAME = 'Portal Agência A';
const AGENCY_B_NAME = 'Portal Agência B';
const ADMIN_NAME = 'Adriana Admin Interna';
const PHOTO_KEY = `agencies/${agencyA}/clients/${clientA1}/avatar/${randomUUID()}.png`;
const OTHER_PHOTO_KEY = `agencies/${agencyA}/clients/${clientA2}/avatar/${randomUUID()}.png`;

const sessionCookieHeader = (cookiesList: readonly { name: string; value: string }[]): string =>
  cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (key: string, name: string): Promise<void> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `portal-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const portalClient = (clientId: string): string => `/clients/${clientId}`;
const portalStudy = (clientId: string): string => `/clients/${clientId}/brand-study`;

/** One 404 for every way of not being the portal of that client, never a 403 that would confirm the client. */
const expectNotFound = async (url: string, cookie: string | undefined, label: string): Promise<void> => {
  const response = await call('GET', url, cookie);
  expect(response.statusCode, `${label}: ${url}`).toBe(cookie === undefined ? 401 : 404);
  if (cookie !== undefined) expect(response.json().error.code, label).toBe('NOT_FOUND');
};

const sectionOf = (body: { sections: { key: string }[] }, key: string): Record<string, unknown> =>
  body.sections.find((section) => section.key === key) as unknown as Record<string, unknown>;

const iso = (value: unknown): string => new Date(value as string).toISOString();

const home = async (cookie: string, clientId = clientHome): Promise<{ threadsAnsweredByAgency: number; brandStudyFilled: number }> => {
  const response = await call('GET', portalClient(clientId), cookie);
  expect(response.statusCode).toBe(200);
  return response.json().home;
};

describe('CLIENTS portal reads (#129)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    await makeUser('admin', ADMIN_NAME);
    await makeUser('manager', 'Marta Gestora');
    await makeUser('ownerUser', 'Dona da Agência');
    await makeUser('portalOne', 'Ana do Portal');
    await makeUser('portalTwo', 'Bruno do Portal');
    await makeUser('portalOther', 'Portal Outro Cliente');
    await makeUser('portalB', 'Portal Outra Agência');
    await makeUser('portalRemoved', 'Portal Removido');
    await makeUser('portalSuspended', 'Portal Agência Suspensa');
    await makeUser('dual', 'Pessoa Dupla');
    await makeUser('dualBare', 'Pessoa Dupla Sem Cliente');
    await makeUser('crossDual', 'Pessoa Dupla Cruzada');

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => {
      const role = roles.find((candidate) => candidate.key === key);
      if (role === undefined) throw new Error(`Missing system role ${key}.`);
      return role.id as string;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: AGENCY_A_NAME, owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: AGENCY_B_NAME, owner_user_id: null },
      { id: agencySuspended, name: 'Portal Agência Suspensa', owner_user_id: null }
    ]);

    // An agency role with no cliente.* key at all, for the collaborator who also has a client link.
    const unrelatedRole = randomUUID();
    createdCustomRoleIds.push(unrelatedRole);
    await owner.knex('roles').insert({ id: unrelatedRole, agency_id: agencyA, key: `only-midia-${unrelatedRole}`, name: 'Só mídia', is_system: false });
    await owner.knex('role_permissions').insert({ role_id: unrelatedRole, permission_key: 'midia.enviar' });

    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: unrelatedRole },
      { agency_id: agencyA, user_id: users.crossDual!.id, role_id: roleId('admin') }
    ]);

    await owner.knex('clients').insert([
      {
        id: clientA1,
        agency_id: agencyA,
        name: `Portal A1 ${clientA1}`,
        legal_name: 'Padaria Central Ltda',
        tax_id: '12345678000190',
        segment: 'Alimentação',
        website: 'https://padariacentral.exemplo.test',
        instagram_handle: 'padariacentral',
        contact_name: 'Maria Souza',
        contact_phone: '+55 11 90000-0000',
        contact_email: 'maria@padariacentral.exemplo.test',
        closing_date: '2099-12-31',
        photo_key: PHOTO_KEY
      },
      { id: clientA2, agency_id: agencyA, name: `Portal A2 ${clientA2}`, photo_key: OTHER_PHOTO_KEY },
      { id: clientB1, agency_id: agencyB, name: `Portal B1 ${clientB1}` },
      { id: clientArchived, agency_id: agencyA, name: `Portal Arquivado ${clientArchived}`, status: 'archived', archived_at: new Date() },
      { id: clientSuspended, agency_id: agencySuspended, name: `Portal Suspenso ${clientSuspended}` },
      { id: clientEmpty, agency_id: agencyA, name: `Portal Vazio ${clientEmpty}` },
      { id: clientHome, agency_id: agencyA, name: `Portal Início ${clientHome}` }
    ]);

    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.portalOne!.id },
      { client_id: clientA1, user_id: users.portalTwo!.id },
      { client_id: clientA1, user_id: users.dual!.id },
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.portalRemoved!.id },
      { client_id: clientA2, user_id: users.portalOther!.id },
      { client_id: clientB1, user_id: users.portalB!.id },
      { client_id: clientB1, user_id: users.crossDual!.id },
      { client_id: clientArchived, user_id: users.portalOne!.id },
      { client_id: clientArchived, user_id: users.dual!.id },
      { client_id: clientSuspended, user_id: users.portalSuspended!.id },
      { client_id: clientEmpty, user_id: users.portalOne!.id },
      { client_id: clientEmpty, user_id: users.dual!.id },
      { client_id: clientHome, user_id: users.portalOne!.id },
      { client_id: clientHome, user_id: users.dual!.id },
      { client_id: clientHome, user_id: users.dualBare!.id }
    ]);

    await owner.knex('client_personas').insert([
      { id: personaActive, client_id: clientA1, name: 'Persona ativa', description: 'Dona de casa.', pains: 'Pouco tempo.', desires: 'Reconhecimento.', objections: 'Preço.', updated_by: users.admin!.id },
      { id: personaArchived, client_id: clientA1, name: 'Persona arquivada', updated_by: users.admin!.id },
      { id: personaOfA2, client_id: clientA2, name: 'Persona do A2', updated_by: users.admin!.id },
      { id: personaHomeActive, client_id: clientHome, name: 'Persona do Início', updated_by: users.admin!.id },
      { id: personaHomeArchived, client_id: clientHome, name: 'Persona arquivada do Início', updated_by: users.admin!.id }
    ]);
    await owner.knex('client_personas').whereIn('id', [personaArchived, personaHomeArchived]).update({ status: 'archived' });
    await owner.knex('client_brand_sections').insert([
      { client_id: clientA1, section_key: 'branding', body: 'Marca acolhedora.', updated_by: users.admin!.id },
      { client_id: clientA1, section_key: 'colors', colors: JSON.stringify([{ name: 'Vinho', hex: '#7A1F2B' }]), updated_by: users.admin!.id },
      { client_id: clientA1, section_key: 'archetype', archetype: 'Cuidador', updated_by: users.admin!.id },
      { client_id: clientA2, section_key: 'branding', body: 'Texto interno do outro cliente.', updated_by: users.admin!.id },
      { client_id: clientHome, section_key: 'branding', body: 'Marca do Início.', updated_by: users.admin!.id },
      // A row that exists but holds nothing does not count as filled.
      { client_id: clientHome, section_key: 'colors', colors: JSON.stringify([]), updated_by: users.admin!.id }
    ]);

    // A login with no valid context is refused, so these two lose their context after the session exists.
    for (const key of Object.keys(users)) cookies[key] = await login(users[key]!);
    await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalRemoved!.id }).update({ status: 'removed' });
    await owner.knex('agencies').where({ id: agencySuspended }).update({ status: 'suspended' });
  });

  afterAll(async () => {
    const agencyIds = [agencyA, agencyB, agencySuspended];
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

  describe('GET /clients/:clientId', () => {
    it('serves the registration, the agency name, the photo and the Início summary to the portal person', async () => {
      const response = await call('GET', portalClient(clientA1), cookies.portalOne!);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toMatchObject({
        id: clientA1,
        name: `Portal A1 ${clientA1}`,
        status: 'active',
        legalName: 'Padaria Central Ltda',
        taxId: '12345678000190',
        segment: 'Alimentação',
        website: 'https://padariacentral.exemplo.test',
        instagramHandle: 'padariacentral',
        contactName: 'Maria Souza',
        contactPhone: '+55 11 90000-0000',
        contactEmail: 'maria@padariacentral.exemplo.test',
        closingDate: '2099-12-31',
        archivedAt: null,
        agencyName: AGENCY_A_NAME,
        onboardingSeenAt: null,
        home: { threadsAnsweredByAgency: 0, brandStudyFilled: 4 }
      });
      expect(Object.keys(body).sort()).toEqual([
        'agencyName', 'archivedAt', 'closingDate', 'contactEmail', 'contactName', 'contactPhone', 'home', 'id',
        'instagramHandle', 'legalName', 'name', 'onboardingSeenAt', 'photoUrl', 'segment', 'status', 'taxId', 'website'
      ]);
    });

    it('signs the photo of the own client and never the key or the photo of another client', async () => {
      const own = (await call('GET', portalClient(clientA1), cookies.portalOne!)).json();
      expect(typeof own.photoUrl).toBe('string');
      expect(decodeURIComponent(new URL(own.photoUrl).pathname)).toContain(PHOTO_KEY);
      expect(JSON.stringify(own)).not.toContain('photo_key');

      // The photo of another client of the same agency is another client's: 404, and that client's own
      // person sees theirs.
      const foreign = await call('GET', portalClient(clientA2), cookies.portalOne!);
      expect(foreign.statusCode).toBe(404);
      expect(JSON.stringify(foreign.json())).not.toContain(OTHER_PHOTO_KEY);
      const theirs = (await call('GET', portalClient(clientA2), cookies.portalOther!)).json();
      expect(decodeURIComponent(new URL(theirs.photoUrl).pathname)).toContain(OTHER_PHOTO_KEY);
      expect(decodeURIComponent(new URL(theirs.photoUrl).pathname)).not.toContain(PHOTO_KEY);

      expect((await call('GET', portalClient(clientEmpty), cookies.portalOne!)).json().photoUrl).toBeNull();
    });

    it('answers 200 to the collaborator who also has a client link, whatever their agency role', async () => {
      for (const key of ['dual', 'dualBare']) {
        const response = await call('GET', portalClient(clientA1), cookies[key]!);
        expect(response.statusCode, key).toBe(200);
        expect(response.json(), key).toMatchObject({ id: clientA1, agencyName: AGENCY_A_NAME, home: { brandStudyFilled: 4 } });
      }
    });

    it('answers the agency of the client for a person who belongs to another agency', async () => {
      const response = await call('GET', portalClient(clientB1), cookies.crossDual!);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: clientB1, agencyName: AGENCY_B_NAME });
      // An admin of agency A has no link to a client of A: the agency workspace is not the portal.
      await expectNotFound(portalClient(clientA1), cookies.crossDual!, 'agency admin without a link');
    });

    it('answers the same 404 to everyone who is not the portal of that client', async () => {
      await expectNotFound(portalClient(clientA1), cookies.portalOther!, 'client A person on a client of the same agency');
      await expectNotFound(portalClient(clientA2), cookies.portalOne!, 'client A1 person on A2');
      await expectNotFound(portalClient(clientA1), cookies.portalB!, 'person of another agency');
      await expectNotFound(portalClient(clientB1), cookies.portalOne!, 'client of another agency');
      await expectNotFound(portalClient(clientA1), cookies.admin!, 'admin without a client link');
      await expectNotFound(portalClient(clientA1), cookies.manager!, 'collaborator without a client link');
      await expectNotFound(portalClient(clientA1), cookies.ownerUser!, 'owner without a client link');
      await expectNotFound(portalClient(clientA1), cookies.portalRemoved!, 'removed link');
      await expectNotFound(portalClient(clientArchived), cookies.portalOne!, 'archived client');
      // The collaborator reads an archived client through the agency branch, so the guard's own status check is what stops them.
      await expectNotFound(portalClient(clientArchived), cookies.dual!, 'archived client, collaborator with a link');
      await expectNotFound(portalClient(clientSuspended), cookies.portalSuspended!, 'suspended agency');
      await expectNotFound(portalClient('not-a-uuid'), cookies.portalOne!, 'malformed id');
      await expectNotFound(portalClient(randomUUID()), cookies.portalOne!, 'unknown id');
      await expectNotFound(portalClient(clientA1), undefined, 'no session');
    });

    it('stops serving a person the moment their link is removed, and only that person', async () => {
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalTwo!.id }).update({ status: 'removed' });
      try {
        await expectNotFound(portalClient(clientA1), cookies.portalTwo!, 'removed after the session started');
        expect((await call('GET', portalClient(clientA1), cookies.portalOne!)).statusCode).toBe(200);
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalTwo!.id }).update({ status: 'active' });
      }
      expect((await call('GET', portalClient(clientA1), cookies.portalTwo!)).statusCode).toBe(200);
    });

    it('reads onboardingSeenAt from the link of whoever calls, not from another person of the same client', async () => {
      const seenAt = '2026-10-01T12:00:00.000Z';
      await owner.knex('client_memberships').where({ client_id: clientA1, user_id: users.portalOne!.id }).update({ onboarding_seen_at: seenAt });
      try {
        expect((await call('GET', portalClient(clientA1), cookies.portalOne!)).json().onboardingSeenAt).toBe(seenAt);
        expect((await call('GET', portalClient(clientA1), cookies.portalTwo!)).json().onboardingSeenAt).toBeNull();
        expect((await call('GET', portalClient(clientA1), cookies.dual!)).json().onboardingSeenAt).toBeNull();

        const marked = await call('POST', `${portalClient(clientA1)}/onboarding/seen`, cookies.portalTwo!);
        expect(marked.statusCode).toBe(204);
        const second = (await call('GET', portalClient(clientA1), cookies.portalTwo!)).json().onboardingSeenAt;
        expect(typeof second).toBe('string');
        expect(iso(second)).toBe(second);
        expect((await call('GET', portalClient(clientA1), cookies.portalOne!)).json().onboardingSeenAt).toBe(seenAt);
        // The same person on another client has their own link, and it is still unseen.
        expect((await call('GET', portalClient(clientEmpty), cookies.portalOne!)).json().onboardingSeenAt).toBeNull();
      } finally {
        await owner.knex('client_memberships').where({ client_id: clientA1 }).whereIn('user_id', [users.portalOne!.id, users.portalTwo!.id]).update({ onboarding_seen_at: null });
      }
    });

    it('rejects a query parameter the route does not declare', async () => {
      expect((await call('GET', `${portalClient(clientA1)}?x=1`, cookies.portalOne!)).statusCode).toBe(400);
    });

    describe('home', () => {
      const threadsOf = (clientId: string): Promise<{ id: string }[]> => owner.knex('client_threads').where({ client_id: clientId }).select('id');

      it('counts the open threads the agency answered last, rises on an agency reply and falls on a client comment', async () => {
        for (const key of ['portalOne', 'dual', 'dualBare']) expect(await home(cookies[key]!), key).toEqual({ threadsAnsweredByAgency: 0, brandStudyFilled: 2 });

        const opened = await call('POST', `${portalClient(clientHome)}/threads`, cookies.portalOne!, { subject: { sectionKey: 'branding' }, body: 'Posso sugerir algo?' });
        expect(opened.statusCode).toBe(201);
        const threadId = opened.json().thread.id as string;
        // The client spoke last: nothing is waiting for the person.
        expect((await home(cookies.portalOne!)).threadsAnsweredByAgency).toBe(0);

        const answered = await call('POST', `/agencies/${agencyA}/clients/${clientHome}/threads/${threadId}/comments`, cookies.manager!, { body: 'Claro, conte mais.' });
        expect(answered.statusCode).toBe(201);
        for (const key of ['portalOne', 'dual', 'dualBare']) expect((await home(cookies[key]!)).threadsAnsweredByAgency, key).toBe(1);

        const replied = await call('POST', `${portalClient(clientHome)}/threads/${threadId}/comments`, cookies.portalOne!, { body: 'Obrigada!' });
        expect(replied.statusCode).toBe(201);
        for (const key of ['portalOne', 'dual', 'dualBare']) expect((await home(cookies[key]!)).threadsAnsweredByAgency, key).toBe(0);

        // Agency answers again, then resolves: a resolved thread is nobody's pending reply.
        await call('POST', `/agencies/${agencyA}/clients/${clientHome}/threads/${threadId}/comments`, cookies.manager!, { body: 'Combinado.' });
        expect((await home(cookies.portalOne!)).threadsAnsweredByAgency).toBe(1);
        const resolved = await call('POST', `/agencies/${agencyA}/clients/${clientHome}/threads/${threadId}/resolve`, cookies.manager!);
        expect(resolved.statusCode).toBe(200);
        expect((await home(cookies.portalOne!)).threadsAnsweredByAgency).toBe(0);
        await call('POST', `${portalClient(clientHome)}/threads/${threadId}/comments`, cookies.portalOne!, { body: 'Mais uma ideia.' });
        await call('POST', `/agencies/${agencyA}/clients/${clientHome}/threads/${threadId}/comments`, cookies.manager!, { body: 'Anotado.' });
        expect((await home(cookies.portalOne!)).threadsAnsweredByAgency).toBe(1);
      });

      it('leaves out a thread about an archived persona, for the person who reads it through the agency too', async () => {
        const before = await home(cookies.dual!);
        const threadId = randomUUID();
        await owner.knex('client_threads').insert({ id: threadId, client_id: clientHome, persona_id: personaHomeArchived, opened_by: users.portalOne!.id, opened_side: 'client', created_at: '2026-10-02T10:00:00Z' });
        await owner.knex('client_thread_comments').insert([
          { thread_id: threadId, client_id: clientHome, author_user_id: users.portalOne!.id, author_side: 'client', body: 'Sobre a persona antiga', created_at: '2026-10-02T10:00:00Z' },
          { thread_id: threadId, client_id: clientHome, author_user_id: users.manager!.id, author_side: 'agency', body: 'Resposta da agência', created_at: '2026-10-02T11:00:00Z' }
        ]);
        // The precondition that makes the assertion mean something: the thread is open and the agency spoke last.
        expect(await owner.knex('client_threads').where({ id: threadId }).first()).toMatchObject({ resolved_at: null, persona_id: personaHomeArchived });

        for (const key of ['portalOne', 'dual', 'dualBare']) expect(await home(cookies[key]!), key).toEqual(before);

        // Unarchived, the persona is on the portal again and so is the reply.
        await owner.knex('client_personas').where({ id: personaHomeArchived }).update({ status: 'active' });
        try {
          for (const key of ['portalOne', 'dual']) expect((await home(cookies[key]!)).threadsAnsweredByAgency, key).toBe(before.threadsAnsweredByAgency + 1);
        } finally {
          await owner.knex('client_personas').where({ id: personaHomeArchived }).update({ status: 'archived' });
        }
      });

      it('counts only the client of the route, although the collaborator reads every client of the agency', async () => {
        const before = await home(cookies.dual!);
        const threadId = randomUUID();
        await owner.knex('client_threads').insert({ id: threadId, client_id: clientA2, section_key: 'branding', opened_by: users.portalOther!.id, opened_side: 'client', created_at: '2026-10-03T10:00:00Z' });
        await owner.knex('client_thread_comments').insert([
          { thread_id: threadId, client_id: clientA2, author_user_id: users.portalOther!.id, author_side: 'client', body: 'Pergunta do A2', created_at: '2026-10-03T10:00:00Z' },
          { thread_id: threadId, client_id: clientA2, author_user_id: users.manager!.id, author_side: 'agency', body: 'Resposta do A2', created_at: '2026-10-03T11:00:00Z' }
        ]);
        expect((await threadsOf(clientA2)).length).toBeGreaterThan(0);

        expect(await home(cookies.dual!)).toEqual(before);
        expect(await home(cookies.portalOne!)).toEqual(before);
        expect((await home(cookies.portalOther!, clientA2)).threadsAnsweredByAgency).toBe(1);
      });

      it('fills the study count by the same definition as the brand study, and personas only while active', async () => {
        const study = (await call('GET', portalStudy(clientHome), cookies.portalOne!)).json();
        expect(study.filled).toBe((await home(cookies.portalOne!)).brandStudyFilled);
        expect(study.filled).toBe(2);

        await owner.knex('client_personas').where({ id: personaHomeActive }).update({ status: 'archived' });
        try {
          expect((await home(cookies.portalOne!)).brandStudyFilled).toBe(1);
          expect((await home(cookies.dual!)).brandStudyFilled).toBe(1);
          expect((await call('GET', portalStudy(clientHome), cookies.dual!)).json().filled).toBe(1);
        } finally {
          await owner.knex('client_personas').where({ id: personaHomeActive }).update({ status: 'active' });
        }
        expect((await home(cookies.portalOne!)).brandStudyFilled).toBe(2);
      });
    });
  });

  describe('GET /clients/:clientId/brand-study', () => {
    it('serves the seven sections in order and the active personas, without who edited them', async () => {
      const response = await call('GET', portalStudy(clientA1), cookies.portalOne!);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.filled).toBe(4);
      expect(body.sections.map((section: { key: string }) => section.key)).toEqual([
        'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
      ]);
      expect(sectionOf(body, 'branding')).toMatchObject({ body: 'Marca acolhedora.', colors: null, archetype: null });
      expect(sectionOf(body, 'colors')).toMatchObject({ body: null, colors: [{ name: 'Vinho', hex: '#7A1F2B' }], archetype: null });
      expect(sectionOf(body, 'archetype')).toMatchObject({ body: null, colors: null, archetype: 'caregiver' });
      expect(sectionOf(body, 'tone_of_voice')).toEqual({ key: 'tone_of_voice', body: null, colors: null, archetype: null, updatedAt: null });
      expect(typeof sectionOf(body, 'branding').updatedAt).toBe('string');

      expect(body.personas).toEqual([{
        id: personaActive,
        name: 'Persona ativa',
        description: 'Dona de casa.',
        pains: 'Pouco tempo.',
        desires: 'Reconhecimento.',
        objections: 'Preço.',
        status: 'active',
        updatedAt: expect.any(String)
      }]);

      // Who edited internally is the agency's information: not a key, not a name, not an id.
      for (const section of body.sections) expect(Object.keys(section).sort()).toEqual(['archetype', 'body', 'colors', 'key', 'updatedAt']);
      expect(JSON.stringify(body)).not.toContain('updatedBy');
      expect(JSON.stringify(body)).not.toContain(ADMIN_NAME);
      expect(JSON.stringify(body)).not.toContain(users.admin!.id);
    });

    it('hides an archived persona from the portal, the collaborator with a client link included, and brings it back unarchived', async () => {
      for (const key of ['portalOne', 'portalTwo', 'dual', 'dualBare']) {
        const body = (await call('GET', portalStudy(clientA1), cookies[key]!)).json();
        expect(body.personas.map((persona: { id: string }) => persona.id), key).toEqual([personaActive]);
      }

      // The agency still sees both: the persona is there, it is the portal that does not show it.
      const agencySide = (await call('GET', `/agencies/${agencyA}/clients/${clientA1}/brand-study`, cookies.manager!)).json();
      expect(agencySide.personas.map((persona: { id: string }) => persona.id).sort()).toEqual([personaActive, personaArchived].sort());

      await owner.knex('client_personas').where({ id: personaArchived }).update({ status: 'active' });
      try {
        for (const key of ['portalOne', 'dual', 'dualBare']) {
          const body = (await call('GET', portalStudy(clientA1), cookies[key]!)).json();
          expect(body.personas.map((persona: { id: string }) => persona.id).sort(), key).toEqual([personaActive, personaArchived].sort());
        }
      } finally {
        await owner.knex('client_personas').where({ id: personaArchived }).update({ status: 'archived' });
      }
      expect((await call('GET', portalStudy(clientA1), cookies.dual!)).json().personas).toHaveLength(1);
    });

    it('serves only the client of the route to the collaborator who reads every client of the agency', async () => {
      for (const key of ['dual', 'dualBare', 'portalOne']) {
        const body = (await call('GET', portalStudy(clientA1), cookies[key]!)).json();
        expect(JSON.stringify(body), key).not.toContain('Texto interno do outro cliente.');
        expect(JSON.stringify(body), key).not.toContain(personaOfA2);
        expect(sectionOf(body, 'branding'), key).toMatchObject({ body: 'Marca acolhedora.' });
      }
    });

    it('serves seven empty sections and no persona for a client the agency has not studied yet', async () => {
      for (const key of ['portalOne', 'dual']) {
        const body = (await call('GET', portalStudy(clientEmpty), cookies[key]!)).json();
        expect(body, key).toEqual({
          filled: 0,
          sections: ['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations']
            .map((sectionKey) => ({ key: sectionKey, body: null, colors: null, archetype: null, updatedAt: null })),
          personas: []
        });
      }
    });

    it('answers the same 404 to everyone who is not the portal of that client', async () => {
      await expectNotFound(portalStudy(clientA1), cookies.portalOther!, 'client A person on a client of the same agency');
      await expectNotFound(portalStudy(clientA2), cookies.portalOne!, 'client A1 person on A2');
      await expectNotFound(portalStudy(clientA1), cookies.portalB!, 'person of another agency');
      await expectNotFound(portalStudy(clientB1), cookies.portalOne!, 'client of another agency');
      await expectNotFound(portalStudy(clientA1), cookies.admin!, 'admin without a client link');
      await expectNotFound(portalStudy(clientA1), cookies.manager!, 'collaborator without a client link');
      await expectNotFound(portalStudy(clientA1), cookies.ownerUser!, 'owner without a client link');
      await expectNotFound(portalStudy(clientA1), cookies.portalRemoved!, 'removed link');
      await expectNotFound(portalStudy(clientArchived), cookies.portalOne!, 'archived client');
      await expectNotFound(portalStudy(clientArchived), cookies.dual!, 'archived client, collaborator with a link');
      await expectNotFound(portalStudy(clientSuspended), cookies.portalSuspended!, 'suspended agency');
      await expectNotFound(portalStudy('not-a-uuid'), cookies.portalOne!, 'malformed id');
      await expectNotFound(portalStudy(randomUUID()), cookies.portalOne!, 'unknown id');
      await expectNotFound(portalStudy(clientA1), undefined, 'no session');
      await expectNotFound(portalStudy(clientA1), cookies.crossDual!, 'agency admin without a link');
    });

    it('rejects a query parameter the route does not declare', async () => {
      expect((await call('GET', `${portalStudy(clientA1)}?includeArchived=true`, cookies.portalOne!)).statusCode).toBe(400);
    });
  });
});
