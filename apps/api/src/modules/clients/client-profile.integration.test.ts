import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
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
import { loadClientTabCounts } from './service.js';

// Decisions 2026-11-11 (the client gains a city and "quem trabalha neste cliente" is derived; the persona gains age, occupation, location,
// traits, where they are and the tone that works). Every scenario of isolation uses a person who belongs to more than one tenant, so a
// missing filter shows up as a leaked row and not as a policy that hid it.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string | undefined, payload?: unknown): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const errorOf = (reply: Reply): { code?: string; details?: { issues?: Array<{ path: string }> } } => {
  const body = reply.json();
  return typeof body.error === 'object' && body.error !== null ? body.error : body;
};

const NO_DATABASE_DETAIL = /23514|_check|check constraint|app_private|pg_|relation|violates/i;

const clientsOf = (agencyId: string): string => `/agencies/${agencyId}/clients`;
const clientRow = (clientId: string): Promise<Record<string, unknown> | undefined> => owner.knex('clients').where({ id: clientId }).first();
const personaRow = (personaId: string): Promise<Record<string, unknown> | undefined> => owner.knex('client_personas').where({ id: personaId }).first();

const createdClientIds: string[] = [];
const newClient = async (label: string, agencyId = agencyA, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID();
  createdClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `Perfil ${label} ${id}`, ...extra });
  return id;
};

const sessionCookie = (cookiesList: readonly { name: string; value: string }[]): string => cookiesList.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const makeUser = async (key: string, name: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `profile-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

const loginAs = async (user: TestUserFixture): Promise<string> => {
  const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(login.statusCode, user.email).toBe(200);
  return sessionCookie(login.cookies);
};

const systemRoleId = async (key: string): Promise<string> => (await owner.knex('roles').whereNull('agency_id').where({ key }).first('id'))!.id as string;

const sao = async (sql: string): Promise<string> =>
  ((await owner.knex.raw(sql)).rows[0] as { day: string }).day;
const today = (): Promise<string> => sao('select app_private.sao_paulo_date(pg_catalog.now())::text as day');
const firstOfMonth = (monthsAhead: number): Promise<string> =>
  sao(`select (date_trunc('month', app_private.sao_paulo_date(pg_catalog.now())::timestamp) + interval '${monthsAhead} month')::date::text as day`);
const lastOfMonth = (monthsAhead: number): Promise<string> =>
  sao(`select (date_trunc('month', app_private.sao_paulo_date(pg_catalog.now())::timestamp) + interval '${monthsAhead + 1} month' - interval '1 day')::date::text as day`);

type ContentStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';

const folderOf = async (clientId: string): Promise<string> => {
  const existing = await owner.knex('media_folders').where({ client_id: clientId }).first('id');
  if (existing !== undefined) return existing.id as string;
  const id = randomUUID();
  await owner.knex('media_folders').insert({ id, client_id: clientId, name: 'Vídeos', is_default: false });
  return id;
};

const seedContent = async (clientId: string, responsible: string, status: ContentStatus, publishOn: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('contents').insert({
    id,
    client_id: clientId,
    title: `Conteúdo ${status} ${id.slice(0, 8)}`,
    platform: 'instagram',
    format: 'reels',
    publish_on: publishOn,
    folder_id: await folderOf(clientId),
    owner_user_id: responsible,
    status,
    ...(status === 'approved' || status === 'published' ? { approved_by: responsible, approved_at: '2026-10-05T12:00:00Z' } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: '2026-10-06T15:00:00Z' } : {}),
    ...(status === 'cancelled' ? { cancelled_at: '2026-10-05T12:00:00Z' } : {})
  });
  return id;
};

const seedAsset = async (clientId: string, state: 'confirmed' | 'pending' | 'rejected' | 'removed', category: 'image' | 'video' = 'image'): Promise<void> => {
  const id = randomUUID();
  const extension = category === 'image' ? 'png' : 'mp4';
  const contentType = category === 'image' ? 'image/png' : 'video/mp4';
  const folder = await owner.knex('media_folders').where({ client_id: clientId, name: category === 'image' ? 'Imagens' : 'Vídeos', is_default: true }).first('id');
  await owner.knex('media_assets').insert({
    id,
    agency_id: agencyA,
    client_id: clientId,
    folder_id: folder?.id ?? null,
    category,
    declared_content_type: contentType,
    extension,
    object_key: `${agencyA}/${id}/original.${extension}`,
    upload_object_key: `staging/${agencyA}/${id}/upload.${extension}`,
    declared_size_bytes: 1_000,
    created_by_user_id: users.admin!.id,
    ...(state === 'confirmed' || state === 'removed' ? { status: 'confirmed', confirmed_size_bytes: 1_000, confirmed_content_type: contentType, confirmed_at: new Date() } : {}),
    ...(state === 'rejected' ? { status: 'rejected', rejected_reason: 'Formato inválido' } : {}),
    ...(state === 'removed' ? { removed_at: new Date() } : {}),
    ...(category === 'video' && state !== 'pending' && state !== 'rejected' ? { video_processing_status: 'pending' } : {})
  });
};

describe('CLIENTES city, tab counts, workers and persona profile (decisions 2026-11-11)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    for (const [key, name] of [
      ['ownerUser', 'Dona da Agência'], ['admin', 'Adriana Admin'], ['clientsOnly', 'Só Clientes'], ['clientsContent', 'Clientes e Conteúdo'],
      ['otherAdmin', 'Admin da Outra'], ['portal', 'Ana do Portal'], ['dual', 'Pessoa Dupla'],
      ['w1', 'Trabalhador Um'], ['w2', 'Trabalhador Dois'], ['w3', 'Trabalhador Três'], ['w4', 'Trabalhador Quatro'],
      ['w5', 'Trabalhador Cinco'], ['w6', 'Trabalhador Seis'], ['w7', 'Trabalhador Sete'], ['w8', 'Trabalhador Oito']
    ] as const) await makeUser(key, name);

    const systemRoles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => systemRoles.find((candidate) => candidate.key === key)!.id as string;
    const customRole = async (agencyId: string, ...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyId, key: `only-${id}`, name: `Só ${permissions.join(' e ')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Perfil do Cliente A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Perfil do Cliente B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.clientsOnly!.id, role_id: await customRole(agencyA, 'cliente.visualizar') },
      { agency_id: agencyA, user_id: users.clientsContent!.id, role_id: await customRole(agencyA, 'cliente.visualizar', 'conteudo.visualizar') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.dual!.id, role_id: roleId('production') },
      { agency_id: agencyB, user_id: users.dual!.id, role_id: roleId('admin') },
      ...(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'] as const).map((key) => ({ agency_id: agencyA, user_id: users[key]!.id, role_id: roleId('production') }))
    ]);

    for (const key of Object.keys(users)) cookies[key] = await loginAs(users[key]!);
  });

  afterAll(async () => {
    const clientIds = await owner.knex('clients').whereIn('agency_id', [agencyA, agencyB]).pluck('id');
    await owner.knex('audit.events').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('media_assets').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('client_id', clientIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('client_personas').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
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

  describe('the city of the client', () => {
    it('is kept as one trimmed line when the client is created, and starts as null without it', async () => {
      const created = await call('POST', clientsOf(agencyA), cookies.admin, { name: `Com cidade ${randomUUID()}`, city: '  São José do Rio Preto  ' });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ city: 'São José do Rio Preto', createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) });
      const stored = await clientRow(created.json().id);
      expect(stored).toMatchObject({ city: 'São José do Rio Preto' });
      expect(created.json().createdAt).toBe((stored!.created_at as Date).toISOString());
      expect((await call('GET', `${clientsOf(agencyA)}/${created.json().id}`, cookies.admin)).json().createdAt).toBe((stored!.created_at as Date).toISOString());

      const without = await call('POST', clientsOf(agencyA), cookies.admin, { name: `Sem cidade ${randomUUID()}` });
      expect(without.statusCode).toBe(201);
      expect(without.json()).toMatchObject({ city: null });
      expect((await call('POST', clientsOf(agencyA), cookies.admin, { name: `Cidade vazia ${randomUUID()}`, city: '   ' })).json()).toMatchObject({ city: null });
    });

    it('is edited and cleared, and a patch of another field leaves it alone', async () => {
      const client = await newClient('cidade-edicao');
      const set = await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: 'Campinas' });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ city: 'Campinas' });
      expect(await clientRow(client)).toMatchObject({ city: 'Campinas' });

      expect((await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { segment: 'Alimentação' })).json()).toMatchObject({ city: 'Campinas', segment: 'Alimentação' });
      expect((await call('GET', `${clientsOf(agencyA)}/${client}`, cookies.admin)).json()).toMatchObject({ city: 'Campinas' });

      expect((await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: null })).json()).toMatchObject({ city: null });
      expect((await clientRow(client))?.city).toBeNull();
      await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: 'Santos' });
      expect((await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: '   ' })).json()).toMatchObject({ city: null });
    });

    it('refuses a city that is long, in several lines, hidden, or not text, with a 400 that names the field, and writes nothing', async () => {
      const client = await newClient('cidade-limites', agencyA, { city: 'Original' });
      const before = await owner.knex('clients').where({ agency_id: agencyA }).count<{ count: string }[]>('id as count');
      for (const city of ['a'.repeat(81), 'ç'.repeat(81), 'Linha um\nlinha dois', 'Tab\taqui', 'Sino\u0007aqui', 'Nulo\u0000aqui', 'Oculto​aqui', 'Controle\u0085aqui', 'Bidi‮aqui', 5, ['Campinas'], { name: 'x' }]) {
        const label = JSON.stringify(city)?.slice(0, 24);
        const patched = await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city });
        expect(patched.statusCode, label).toBe(400);
        expect(errorOf(patched).code, label).toBe('VALIDATION_ERROR');
        expect(errorOf(patched).details?.issues?.[0]?.path, label).toBe('city');
        expect(JSON.stringify(patched.json())).not.toMatch(NO_DATABASE_DETAIL);
        const created = await call('POST', clientsOf(agencyA), cookies.admin, { name: `Cidade ruim ${randomUUID()}`, city });
        expect(created.statusCode, label).toBe(400);
      }
      expect(await clientRow(client)).toMatchObject({ city: 'Original' });
      expect(await owner.knex('clients').where({ agency_id: agencyA }).count<{ count: string }[]>('id as count')).toEqual(before);
      expect((await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: 'a'.repeat(80) })).statusCode).toBe(200);
    });

    it('asks cliente.operar to edit and cliente.cadastrar to create, and never writes for another agency, a portal person or an archived client', async () => {
      const client = await newClient('cidade-permissao', agencyA, { city: 'Original' });
      const foreign = await newClient('cidade-de-outra', agencyB, { city: 'Original' });
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portal!.id });

      expect((await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.clientsOnly, { city: 'Invasão' })).statusCode).toBe(403);
      expect((await call('POST', clientsOf(agencyA), cookies.clientsOnly, { name: `Sem permissão ${randomUUID()}`, city: 'Invasão' })).statusCode).toBe(403);
      for (const attempt of [
        call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.otherAdmin, { city: 'Invasão' }),
        call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.portal, { city: 'Invasão' }),
        call('PATCH', `${clientsOf(agencyA)}/${client}`, undefined, { city: 'Invasão' }),
        call('PATCH', `${clientsOf(agencyB)}/${client}`, cookies.otherAdmin, { city: 'Invasão' }),
        call('PATCH', `${clientsOf(agencyA)}/${foreign}`, cookies.admin, { city: 'Invasão' })
      ]) expect([401, 403, 404]).toContain((await attempt).statusCode);
      expect(await clientRow(client)).toMatchObject({ city: 'Original' });
      expect(await clientRow(foreign)).toMatchObject({ city: 'Original' });

      await owner.knex('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });
      const archived = await call('PATCH', `${clientsOf(agencyA)}/${client}`, cookies.admin, { city: 'Invasão' });
      expect(archived.statusCode).toBe(409);
      expect(await clientRow(client)).toMatchObject({ city: 'Original' });
    });

    it('reaches the portal, whose person reads the city of the own client and of no other', async () => {
      const client = await newClient('cidade-no-portal', agencyA, { city: 'Campinas' });
      const other = await newClient('cidade-de-outro', agencyA, { city: 'Outra' });
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portal!.id });
      const own = await call('GET', `/clients/${client}`, cookies.portal);
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ city: 'Campinas', createdAt: expect.any(String) });
      expect((await call('GET', `/clients/${other}`, cookies.portal)).statusCode).toBe(404);
    });
  });

  describe('the counts of the tabs and the people who work on the client', () => {
    const SUMMARY_KEYS_WITHOUT_CONTENT = ['activePortalMembers', 'brandStudyFilled', 'threadsAnsweredByAgency', 'threadsAwaitingAgency'];
    const detail = async (who: string, client: string, agencyId = agencyA): Promise<Reply> => call('GET', `${clientsOf(agencyId)}/${client}`, cookies[who]);

    it('counts the contents planned in the current month in São Paulo, cancelled ones out, with the neighbouring months and clients as controls', async () => {
      const client = await newClient('conteudos-do-mes');
      const other = await newClient('conteudos-de-outro');
      const responsible = users.admin!.id;
      const [first, last, previousLast, nextFirst] = [await firstOfMonth(0), await lastOfMonth(0), await lastOfMonth(-1), await firstOfMonth(1)];

      await seedContent(client, responsible, 'in_production', first);
      await seedContent(client, responsible, 'approved', await today());
      await seedContent(client, responsible, 'published', last);
      await seedContent(client, responsible, 'awaiting_approval', first);
      await seedContent(client, responsible, 'cancelled', first);
      await seedContent(client, responsible, 'in_production', previousLast);
      await seedContent(client, responsible, 'in_production', nextFirst);
      await seedContent(other, responsible, 'in_production', first);
      await seedContent(other, responsible, 'in_production', last);

      const response = await detail('admin', client);
      expect(response.statusCode).toBe(200);
      expect(response.json().summary).toMatchObject({ contentsThisMonth: 4 });
      expect((await detail('admin', other)).json().summary).toMatchObject({ contentsThisMonth: 2 });
      expect((await detail('admin', await newClient('conteudos-nenhum'))).json().summary).toMatchObject({ contentsThisMonth: 0 });
    });

    it('takes the month from São Paulo and not from UTC at the turn of the month, with the first and the last day inside it', async () => {
      const client = await newClient('virada-do-mes');
      for (const day of ['2031-03-31', '2031-04-01', '2031-04-30', '2031-05-01']) await seedContent(client, users.admin!.id, 'in_production', day);
      const countAt = async (asOf: string): Promise<number> => (await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId: users.admin!.id }), (transaction) =>
        loadClientTabCounts(transaction, { clientId: client, asOf: new Date(asOf) }))).contentsThisMonth;

      expect(await countAt('2031-04-01T02:59:59Z')).toBe(1);
      expect(await countAt('2031-04-01T03:00:00Z')).toBe(2);
      expect(await countAt('2031-05-01T02:59:59Z')).toBe(2);
      expect(await countAt('2031-05-01T03:00:00Z')).toBe(1);
    });

    it('counts the confirmed files that were not removed and every folder of the client, and no other client', async () => {
      const client = await newClient('midias');
      const other = await newClient('midias-de-outro');
      const defaults = Number((await owner.knex('media_folders').where({ client_id: client }).count<{ count: string }[]>('id as count'))[0]!.count);
      expect(defaults).toBeGreaterThan(0);
      await owner.knex('media_folders').insert({ id: randomUUID(), client_id: client, name: 'Campanha', is_default: false });
      await owner.knex('media_folders').insert({ id: randomUUID(), client_id: other, name: 'Campanha de outro', is_default: false });

      for (const state of ['confirmed', 'confirmed', 'pending', 'rejected', 'removed'] as const) await seedAsset(client, state);
      await seedAsset(client, 'confirmed', 'video');
      await seedAsset(other, 'confirmed');
      await seedAsset(other, 'confirmed');

      const summary = (await detail('admin', client)).json().summary;
      expect(summary).toMatchObject({ mediaFiles: 3, mediaFolders: defaults + 1 });
      expect((await detail('admin', other)).json().summary).toMatchObject({ mediaFiles: 2, mediaFolders: defaults + 1 });
    });

    it('names the people in charge of the open contents, most contents first, five of them and the rest as a number, by the link and never by the account', async () => {
      const client = await newClient('quem-trabalha');
      const when = await today();
      const give = async (who: string, status: ContentStatus, times: number): Promise<void> => {
        for (let index = 0; index < times; index += 1) await seedContent(client, users[who]!.id, status, when);
      };
      await give('w1', 'in_production', 3);
      await give('w2', 'awaiting_approval', 2);
      await give('w2', 'published', 4);
      await give('w3', 'adjusting', 1);
      await give('w3', 'approved', 1);
      await give('w4', 'in_production', 1);
      await give('w5', 'in_production', 1);
      await give('w6', 'in_production', 1);
      await give('w7', 'published', 2);
      await give('w7', 'cancelled', 2);
      await give('w8', 'in_production', 1);
      await give('ownerUser', 'in_production', 1);
      await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.w8!.id }).update({ status: 'removed' });
      await app.pool.query('update auth."user" set image = $1 where id = $2', [`users/${users.w1!.id}/avatar/photo.png`, users.w1!.id]);

      try {
        const response = await detail('admin', client);
        expect(response.statusCode).toBe(200);
        const { workers, workersMore } = response.json().summary as { workers: Array<{ membershipId: string; name: string; photoUrl: string | null }>; workersMore: number };
        expect(workers.map((worker) => worker.name)).toEqual(['Trabalhador Um', 'Trabalhador Dois', 'Trabalhador Três', 'Trabalhador Cinco', 'Trabalhador Quatro']);
        expect(workersMore).toBe(1);
        const links = await owner.knex('agency_memberships').where({ agency_id: agencyA }).whereIn('user_id', Object.values(users).map((user) => user.id)).select('id', 'user_id');
        for (const worker of workers) {
          expect(links.map((link) => link.id), worker.name).toContain(worker.membershipId);
          expect(Object.keys(worker).sort(), worker.name).toEqual(['membershipId', 'name', 'photoUrl']);
        }
        expect(workers[0]!.photoUrl).toContain(`users/${users.w1!.id}/avatar/photo.png`);
        expect(workers[1]!.photoUrl).toBeNull();

        // The signed URL of a photo is the storage's own and names the account in its path, as in every comment author; nothing else may.
        const everything = JSON.stringify(response.json()).replace(/"photoUrl":"[^"]*"/g, '"photoUrl":""');
        for (const person of Object.values(users)) {
          expect(everything).not.toContain(person.email);
          expect(everything).not.toContain(person.id);
        }
        expect(everything).not.toContain('Trabalhador Oito');
        expect(everything).not.toContain('Trabalhador Sete');
        expect(everything).not.toContain('Dona da Agência');
      } finally {
        await app.pool.query('update auth."user" set image = null where id = $1', [users.w1!.id]);
      }
    });

    it('breaks a tie of contents by the name, and shows nobody (and no "+N") for a client with no open content', async () => {
      const client = await newClient('quem-trabalha-empate');
      const when = await today();
      for (const who of ['w5', 'w4', 'w6']) await seedContent(client, users[who]!.id, 'in_production', when);
      const tied = (await detail('admin', client)).json().summary as { workers: Array<{ name: string }>; workersMore: number };
      expect(tied.workers.map((worker) => worker.name)).toEqual(['Trabalhador Cinco', 'Trabalhador Quatro', 'Trabalhador Seis']);
      expect(tied.workersMore).toBe(0);

      const empty = (await detail('admin', await newClient('quem-trabalha-ninguem'))).json().summary;
      expect(empty).toMatchObject({ workers: [], workersMore: 0 });
    });

    it('breaks a tie of the same name and the same contents by the link, so the five shown are always the same ones', async () => {
      const client = await newClient('quem-trabalha-gemeos');
      const role = await systemRoleId('production');
      const twins: Array<{ linkId: string; userId: string }> = [];
      for (let index = 1; index <= 6; index += 1) twins.push({ linkId: randomUUID(), userId: (await makeUser(`twin${index}`, 'Gêmeo Idêntico')).id });
      // Inserted from the largest link id to the smallest, so a read that does not sort by it cannot return them in order by chance.
      for (const twin of [...twins].sort((left, right) => (left.linkId < right.linkId ? 1 : -1))) {
        await owner.knex('agency_memberships').insert({ id: twin.linkId, agency_id: agencyA, user_id: twin.userId, role_id: role });
        await seedContent(client, twin.userId, 'in_production', await today());
      }

      const summary = (await detail('admin', client)).json().summary as { workers: Array<{ membershipId: string }>; workersMore: number };
      expect(summary.workers.map((worker) => worker.membershipId)).toEqual(twins.map((twin) => twin.linkId).sort().slice(0, 5));
      expect(summary.workersMore).toBe(1);
    });

    it('names the link of the agency of the client for a person of two agencies even when the reader belongs to both', async () => {
      const reader = await makeUser('readerOfBoth', 'Leitora das Duas');
      const admin = await systemRoleId('admin');
      for (const agencyId of [agencyA, agencyB]) await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: reader.id, role_id: admin });
      const client = await newClient('leitora-das-duas');
      await seedContent(client, users.dual!.id, 'in_production', await today());
      const linkA = (await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.dual!.id }).first('id'))!.id as string;

      const read = await call('GET', `${clientsOf(agencyA)}/${client}`, await loginAs(reader));
      expect(read.statusCode).toBe(200);
      expect(read.json().summary).toMatchObject({ workers: [expect.objectContaining({ membershipId: linkA, name: 'Pessoa Dupla' })], workersMore: 0 });
    });

    it('names, for a person of two agencies, the link of the agency of the client and no other, and no agency reads the client of another', async () => {
      const clientA = await newClient('dupla-a');
      const clientB = await newClient('dupla-b', agencyB);
      await seedContent(clientA, users.dual!.id, 'in_production', await today());
      const linkA = (await owner.knex('agency_memberships').where({ agency_id: agencyA, user_id: users.dual!.id }).first('id'))!.id as string;
      const linkB = (await owner.knex('agency_memberships').where({ agency_id: agencyB, user_id: users.dual!.id }).first('id'))!.id as string;

      const read = (await detail('admin', clientA)).json().summary.workers as Array<{ membershipId: string; name: string }>;
      expect(read).toEqual([expect.objectContaining({ membershipId: linkA, name: 'Pessoa Dupla' })]);
      expect(JSON.stringify(read)).not.toContain(linkB);
      expect((await detail('dual', clientB, agencyB)).json().summary).toMatchObject({ workers: [], workersMore: 0 });

      for (const attempt of [detail('otherAdmin', clientA, agencyA), detail('otherAdmin', clientA, agencyB), detail('admin', clientB, agencyA), detail('admin', clientB, agencyB)]) {
        expect([403, 404]).toContain((await attempt).statusCode);
      }
    });

    it('omits the five fields, and does not zero them, for whoever lacks conteudo.visualizar, and gives them to the owner and to a role that has it', async () => {
      const client = await newClient('omitidos');
      await seedContent(client, users.w1!.id, 'in_production', await today());

      const without = await detail('clientsOnly', client);
      expect(without.statusCode).toBe(200);
      expect(Object.keys(without.json().summary).sort()).toEqual(SUMMARY_KEYS_WITHOUT_CONTENT);
      expect(JSON.stringify(without.json())).not.toContain('Trabalhador Um');

      for (const who of ['admin', 'clientsContent', 'ownerUser']) {
        const summary = (await detail(who, client)).json().summary;
        expect(Object.keys(summary).sort(), who).toEqual([...SUMMARY_KEYS_WITHOUT_CONTENT, 'contentsThisMonth', 'mediaFiles', 'mediaFolders', 'workers', 'workersMore'].sort());
        expect(summary.contentsThisMonth, who).toBe(1);
      }
    });

    it('does not give a portal person the summary of the agency, and a client of the same agency stays out of the counts', async () => {
      const client = await newClient('resumo-portal');
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portal!.id });
      const response = await call('GET', `${clientsOf(agencyA)}/${client}`, cookies.portal);
      expect([403, 404]).toContain(response.statusCode);
      expect(JSON.stringify(response.json())).not.toMatch(/workers|mediaFiles|contentsThisMonth/);
      expect(JSON.stringify((await call('GET', `/clients/${client}`, cookies.portal)).json())).not.toMatch(/workers|mediaFiles|contentsThisMonth/);
    });
  });

  describe('the profile of the persona', () => {
    const PROFILE = {
      age: 34, occupation: 'Dona de padaria', location: 'Campinas, SP', traits: ['Prática', 'Desconfiada', 'Ocupada'],
      whereTheyAre: 'Instagram e grupos de bairro no WhatsApp.', toneThatWorks: 'Próximo, direto e sem jargão.'
    };
    const personas = (agencyId: string, clientId: string): string => `${clientsOf(agencyId)}/${clientId}/personas`;
    const makePersona = async (client: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const created = await call('POST', personas(agencyA, client), cookies.admin, { name: `Persona ${randomUUID()}`, ...extra });
      expect(created.statusCode).toBe(201);
      return created.json().id as string;
    };

    it('is created with the six fields, stored as written, and starts empty without them', async () => {
      const client = await newClient('persona-cria');
      const created = await call('POST', personas(agencyA, client), cookies.admin, { name: 'Marina', ...PROFILE });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ name: 'Marina', ...PROFILE, status: 'active' });
      expect(await personaRow(created.json().id)).toMatchObject({
        age: 34, occupation: 'Dona de padaria', location: 'Campinas, SP', traits: PROFILE.traits,
        where_they_are: PROFILE.whereTheyAre, tone_that_works: PROFILE.toneThatWorks
      });

      const bare = await call('POST', personas(agencyA, client), cookies.admin, { name: 'Sem perfil' });
      expect(bare.json()).toMatchObject({ age: null, occupation: null, location: null, traits: [], whereTheyAre: null, toneThatWorks: null });
      expect(await personaRow(bare.json().id)).toMatchObject({ age: null, traits: null, where_they_are: null });

      const brandStudy = (await call('GET', `${clientsOf(agencyA)}/${client}/brand-study`, cookies.admin)).json();
      expect(brandStudy.personas.find((persona: { id: string }) => persona.id === created.json().id)).toMatchObject(PROFILE);
    });

    it('edits one field at a time and leaves the others, replaces the traits, and clears with null, an empty list or an empty text', async () => {
      const client = await newClient('persona-edita');
      const persona = await makePersona(client, PROFILE);
      const patch = (changes: Record<string, unknown>): Promise<Reply> => call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.admin, changes);

      expect((await patch({ age: 35 })).json()).toMatchObject({ ...PROFILE, age: 35 });
      expect((await patch({ occupation: '  Padeira  ' })).json()).toMatchObject({ ...PROFILE, age: 35, occupation: 'Padeira' });
      expect((await patch({ traits: ['Nova'] })).json()).toMatchObject({ traits: ['Nova'], location: PROFILE.location });
      expect((await personaRow(persona))?.traits).toEqual(['Nova']);

      expect((await patch({ age: null })).json().age).toBeNull();
      expect((await patch({ traits: [] })).json().traits).toEqual([]);
      expect((await personaRow(persona))?.traits).toBeNull();
      expect((await patch({ location: '   ', whereTheyAre: '', toneThatWorks: null })).json()).toMatchObject({ location: null, whereTheyAre: null, toneThatWorks: null });
      expect(await personaRow(persona)).toMatchObject({ age: null, location: null, where_they_are: null, tone_that_works: null, occupation: 'Padeira' });
    });

    it('takes the limits of the decision: age 1 to 120, five traits of 24, one line of 80, and 280 characters that may break lines', async () => {
      const client = await newClient('persona-limites');
      const persona = await makePersona(client, PROFILE);
      const refusedBodies: Array<[string, Record<string, unknown>]> = [
        ['age 0', { age: 0 }], ['age 121', { age: 121 }], ['age 1.5', { age: 1.5 }], ['age text', { age: '30' }], ['age negative', { age: -3 }],
        ['six traits', { traits: ['a', 'b', 'c', 'd', 'e', 'f'] }], ['trait of 25', { traits: ['a'.repeat(25)] }], ['trait empty', { traits: [''] }],
        ['trait blank', { traits: ['   '] }], ['trait with line break', { traits: ['duas\nlinhas'] }], ['trait with control', { traits: ['sino\u0007'] }],
        ['trait hidden', { traits: ['oculto​'] }], ['trait not text', { traits: [5] }], ['traits not a list', { traits: 'Prática' }],
        ['occupation 81', { occupation: 'a'.repeat(81) }], ['occupation with line break', { occupation: 'duas\nlinhas' }], ['location 81', { location: 'a'.repeat(81) }],
        ['location with control', { location: 'sino\u0007' }], ['whereTheyAre 281', { whereTheyAre: 'a'.repeat(281) }], ['whereTheyAre with control', { whereTheyAre: 'sino\u0007' }],
        ['whereTheyAre hidden', { whereTheyAre: 'oculto​' }], ['toneThatWorks 281', { toneThatWorks: 'ç'.repeat(281) }], ['toneThatWorks not text', { toneThatWorks: 7 }],
        ['unknown field', { hobby: 'x' }]
      ];
      for (const [label, body] of refusedBodies) {
        const patched = await call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.admin, body);
        expect(patched.statusCode, label).toBe(400);
        expect(errorOf(patched).code, label).toBe('VALIDATION_ERROR');
        expect(JSON.stringify(patched.json()), label).not.toMatch(NO_DATABASE_DETAIL);
        expect((await call('POST', personas(agencyA, client), cookies.admin, { name: 'Recusada', ...body })).statusCode, label).toBe(400);
      }
      expect(await personaRow(persona)).toMatchObject({ age: 34, occupation: 'Dona de padaria', traits: PROFILE.traits });
      expect(Number((await owner.knex('client_personas').where({ client_id: client }).count<{ count: string }[]>('id as count'))[0]!.count)).toBe(1);

      const accepted = await call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.admin, {
        age: 120, traits: ['a'.repeat(24), 'b', 'c', 'd', 'e'], occupation: 'o'.repeat(80), location: 'l'.repeat(80),
        whereTheyAre: `Linha um\nLinha dois\t${'x'.repeat(250)}`, toneThatWorks: 't'.repeat(280)
      });
      expect(accepted.statusCode).toBe(200);
      expect((await call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.admin, { age: 1 })).json().age).toBe(1);
    });

    it('asks cliente.operar, and never writes for another agency, a portal person or an archived client', async () => {
      const client = await newClient('persona-permissao');
      const foreign = await newClient('persona-de-outra', agencyB);
      const persona = await makePersona(client, PROFILE);
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portal!.id });

      expect((await call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.clientsOnly, { age: 99 })).statusCode).toBe(403);
      expect((await call('POST', personas(agencyA, client), cookies.clientsOnly, { name: 'Sem permissão', ...PROFILE })).statusCode).toBe(403);
      for (const attempt of [
        call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.otherAdmin, { age: 99 }),
        call('PATCH', `${personas(agencyB, client)}/${persona}`, cookies.otherAdmin, { age: 99 }),
        call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.portal, { age: 99 }),
        call('PATCH', `${personas(agencyA, foreign)}/${persona}`, cookies.admin, { age: 99 }),
        call('PATCH', `${personas(agencyA, client)}/${persona}`, undefined, { age: 99 })
      ]) expect([401, 403, 404]).toContain((await attempt).statusCode);
      expect(await personaRow(persona)).toMatchObject({ age: 34 });

      await owner.knex('clients').where({ id: client }).update({ status: 'archived', archived_at: new Date() });
      expect((await call('PATCH', `${personas(agencyA, client)}/${persona}`, cookies.admin, { age: 99 })).statusCode).toBe(409);
      expect((await call('POST', personas(agencyA, client), cookies.admin, { name: 'Tarde demais', ...PROFILE })).statusCode).toBe(409);
      expect(await personaRow(persona)).toMatchObject({ age: 34 });
    });

    it('is read by the portal person of the client, with the six fields, and of no other client', async () => {
      const client = await newClient('persona-portal');
      const other = await newClient('persona-portal-outro');
      const persona = await makePersona(client, PROFILE);
      await makePersona(other, { ...PROFILE, occupation: 'De outro cliente' });
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portal!.id });

      const read = await call('GET', `/clients/${client}/brand-study`, cookies.portal);
      expect(read.statusCode).toBe(200);
      expect(read.json().personas).toEqual([expect.objectContaining({ id: persona, ...PROFILE })]);
      expect(JSON.stringify(read.json())).not.toContain('De outro cliente');
      expect((await call('GET', `/clients/${other}/brand-study`, cookies.portal)).statusCode).toBe(404);
    });
  });
});
