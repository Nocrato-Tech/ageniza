import { randomUUID } from 'node:crypto';

import { createVerifiedUserClaims, withAuthenticatedUserTransaction } from '@ageniza/database';
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
import { listClients } from './service.js';

// Issue #261: the card's content indicators and the delay as the first criterion of the triage
// order, only for who holds `conteudo.visualizar` (specs/conteudo.md sections 2, 4 and 7). Vendas
// and Financeiro get no key at all and keep the order they had.
const origin = { origin: TEST_APP_PUBLIC_URL };

type ContentStatus = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
type Preset = 'admin' | 'account_manager' | 'production' | 'sales' | 'finance';

interface ListItemJson {
  readonly id: string;
  readonly name: string;
  readonly threadsAwaitingAgency: number;
  readonly contentIndicators?: {
    readonly pending: number;
    readonly inReview: number;
    readonly overdue: number;
    readonly adjusting: number;
    readonly dueSoon: number;
  };
}

let app: TestApp;
const owner = ownerClient();
let presetRoleIds: Record<Preset, string>;

const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];
const createdRoleIds: string[] = [];

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (label: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `signals-${label}`, name: `Pessoa ${label}` });
  createdUserIds.push(user.id);
  return user;
};

const createAgency = async (ownerUserId: string | null = null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name: `Agência sinais ${id}`, owner_user_id: ownerUserId, status: 'active' });
  return id;
};

const addMember = async (agencyId: string, roleId: string, label: string): Promise<TestUserFixture> => {
  const user = await makeUser(label);
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: user.id, role_id: roleId });
  return user;
};

const createCustomRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  await owner.knex('roles').insert({ id: roleId, agency_id: agencyId, key: `custom-${roleId.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  await owner.knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: roleId, permission_key })));
  return roleId;
};

const createClient = async (agencyId: string, name: string, status: 'active' | 'archived' = 'active'): Promise<string> => {
  const id = randomUUID();
  await owner.knex('clients').insert({ id, agency_id: agencyId, name, status, archived_at: status === 'archived' ? new Date() : null });
  return id;
};

const folderOf = async (clientId: string): Promise<string> => {
  const existing = await owner.knex('media_folders').where({ client_id: clientId }).first('id');
  if (existing !== undefined) return existing.id as string;
  const id = randomUUID();
  await owner.knex('media_folders').insert({ id, client_id: clientId, name: 'Vídeos', is_default: false });
  return id;
};

const seedContent = async (clientId: string, responsibleId: string, status: ContentStatus, publishOn: string): Promise<string> => {
  const id = randomUUID();
  await owner.knex('contents').insert({
    id,
    client_id: clientId,
    title: `Conteúdo ${status} ${id.slice(0, 8)}`,
    platform: 'instagram',
    format: 'reels',
    publish_on: publishOn,
    folder_id: await folderOf(clientId),
    owner_user_id: responsibleId,
    status,
    ...(status === 'approved' || status === 'published' ? { approved_by: responsibleId, approved_at: '2026-10-05T12:00:00Z' } : {}),
    ...(status === 'published' ? { published_on: '2026-10-06', published_at: '2026-10-06T15:00:00Z' } : {}),
    ...(status === 'cancelled' ? { cancelled_at: '2026-10-05T12:00:00Z' } : {})
  });
  return id;
};

/** An open thread whose last comment is the client's: what "aguardando a agência" counts on a section. */
const seedThread = async (input: { clientId: string; authorId: string; contentId?: string }): Promise<void> => {
  const id = randomUUID();
  await owner.knex('client_threads').insert({
    id,
    client_id: input.clientId,
    opened_by: input.authorId,
    opened_side: 'client',
    ...(input.contentId === undefined ? { section_key: 'branding' } : { content_id: input.contentId })
  });
  await owner.knex('client_thread_comments').insert({
    thread_id: id, client_id: input.clientId, author_user_id: input.authorId, author_side: 'client', body: 'Uma sugestão', created_at: '2026-10-02T10:00:00Z'
  });
};

const getList = async (cookie: string, agencyId: string, query = ''): Promise<{ status: number; data: ListItemJson[] }> => {
  const response = await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients${query}`, headers: { ...origin, cookie } });
  return { status: response.statusCode, data: response.json<{ data: ListItemJson[] }>().data };
};

/** The Brasília day asked of the database that applies the rule, shifted by `days`, so the test never reads its own clock. */
const saoPauloDay = async (days: number): Promise<string> => {
  const result = await owner.knex.raw('select (app_private.sao_paulo_date(pg_catalog.now()) + ?::int)::text as day', [days]);
  return (result.rows[0] as { day: string }).day;
};

/** `listClients` as the user, at a fixed instant: the day of "atrasado" is a function of this instant alone. */
const listAsOf = async (userId: string, agencyId: string, asOf: string): Promise<readonly { overdue: number | null; dueSoon: number | null }[]> => {
  const page = await withAuthenticatedUserTransaction(app.database, createVerifiedUserClaims({ userId }), (transaction) =>
    listClients(transaction, agencyId, {
      status: 'active', sort: 'attention', includePendingInvitations: false, includeContentSignals: true, asOf: new Date(asOf)
    }, { pageSize: 50, offset: 0 }));
  return page.items.map((item) => ({
    overdue: item.content_overdue === null ? null : Number(item.content_overdue),
    dueSoon: item.content_due_soon === null ? null : Number(item.content_due_soon)
  }));
};

describe('CLIENTS content signals on the card and in the triage order (#261)', () => {
  beforeAll(async () => {
    app = await buildTestApp({ sender: createFakeEmailSender() });
    const roles = await owner.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production', 'sales', 'finance']).select('id', 'key');
    presetRoleIds = Object.fromEntries(roles.map((role) => [role.key, role.id])) as Record<Preset, string>;
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = await owner.knex('clients').whereIn('agency_id', agencyIds).pluck('id');
    await owner.knex('client_thread_comments').whereIn('client_id', clientIds).delete();
    await owner.knex('client_threads').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('client_id', clientIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  describe('the indicators and the order, by the route', () => {
    // Alfa has nothing; Beta is late with work in every state; Gama has a client suggestion waiting;
    // Delta has only a comment on a post. The order the caller gets is the whole point.
    const world = async () => {
      const ownerUser = await makeUser('owner');
      const agencyId = await createAgency(ownerUser.id);
      const people = {
        admin: await addMember(agencyId, presetRoleIds.admin, 'admin'),
        production: await addMember(agencyId, presetRoleIds.production, 'production'),
        sales: await addMember(agencyId, presetRoleIds.sales, 'sales'),
        finance: await addMember(agencyId, presetRoleIds.finance, 'finance'),
        clientsOnly: await addMember(agencyId, await createCustomRole(agencyId, ['cliente.visualizar']), 'clients-only'),
        clientsAndContent: await addMember(agencyId, await createCustomRole(agencyId, ['cliente.visualizar', 'conteudo.visualizar']), 'clients-content'),
        ownerUser
      };
      const alfa = await createClient(agencyId, 'Alfa Sinais');
      const beta = await createClient(agencyId, 'Beta Sinais');
      const gama = await createClient(agencyId, 'Gama Sinais');
      const delta = await createClient(agencyId, 'Delta Sinais');
      const yesterday = await saoPauloDay(-1);
      const today = await saoPauloDay(0);
      const tomorrow = await saoPauloDay(1);
      const responsible = people.admin.id;

      await seedContent(beta, responsible, 'in_production', yesterday);
      await seedContent(beta, responsible, 'in_production', today);
      await seedContent(beta, responsible, 'adjusting', tomorrow);
      await seedContent(beta, responsible, 'approved', await saoPauloDay(2));
      await seedContent(beta, responsible, 'approved', await saoPauloDay(3));
      await seedContent(beta, responsible, 'awaiting_approval', yesterday);
      await seedContent(beta, responsible, 'approved', yesterday);
      await seedContent(beta, responsible, 'published', '2026-09-01');
      await seedContent(beta, responsible, 'cancelled', '2026-09-01');
      await seedContent(gama, responsible, 'approved', tomorrow);
      await seedThread({ clientId: gama, authorId: responsible });
      const postOfDelta = await seedContent(delta, responsible, 'awaiting_approval', tomorrow);
      await seedThread({ clientId: delta, authorId: responsible, contentId: postOfDelta });
      return { agencyId, people, ids: { alfa, beta, gama, delta } };
    };

    it('gives the three counts as numbers to who reads Conteúdo: pending, in review, and overdue by the Brasília day', async () => {
      const { agencyId, people, ids } = await world();
      for (const person of [people.admin, people.production, people.clientsAndContent, people.ownerUser]) {
        const { status, data } = await getList(await loginCookie(person), agencyId);
        expect(status).toBe(200);
        const byId = new Map(data.map((item) => [item.id, item]));
        // Beta: em produção (yesterday), em produção (today) and em ajuste are the agency's work; the one
        // awaiting approval is the client's; yesterday's em produção, aguardando and aprovado are late,
        // today's is not, and published and cancelled never count. Due soon is today, tomorrow and two
        // days ahead (the approved of three days ahead is out).
        expect(byId.get(ids.beta)?.contentIndicators, person.email).toEqual({ pending: 3, inReview: 1, overdue: 3, adjusting: 1, dueSoon: 3 });
        expect(byId.get(ids.gama)?.contentIndicators, person.email).toEqual({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 1 });
        expect(byId.get(ids.alfa)?.contentIndicators, person.email).toEqual({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 0 });
        expect(byId.get(ids.delta)?.contentIndicators, person.email).toEqual({ pending: 0, inReview: 1, overdue: 0, adjusting: 0, dueSoon: 1 });
      }
    });

    it('does not send the indicators to Vendas, Financeiro nor a role without conteudo.visualizar: the key is absent, not zero', async () => {
      const { agencyId, people } = await world();
      for (const person of [people.sales, people.finance, people.clientsOnly]) {
        const { status, data } = await getList(await loginCookie(person), agencyId);
        expect(status).toBe(200);
        expect(data).toHaveLength(4);
        for (const item of data) {
          expect(item, person.email).not.toHaveProperty('contentIndicators');
          expect(Object.keys(item), person.email).not.toContain('contentIndicators');
        }
      }
    });

    it('puts the late client first for who reads Conteúdo, then the waiting suggestion, then the name', async () => {
      const { agencyId, people, ids } = await world();
      for (const person of [people.admin, people.clientsAndContent, people.ownerUser]) {
        const { data } = await getList(await loginCookie(person), agencyId);
        expect(data.map((item) => item.id), person.email).toEqual([ids.beta, ids.gama, ids.alfa, ids.delta]);
      }
    });

    it('keeps the order of Vendas, Financeiro and a role without conteudo.visualizar: the late client does not rise', async () => {
      const { agencyId, people, ids } = await world();
      for (const person of [people.sales, people.finance, people.clientsOnly]) {
        const { data } = await getList(await loginCookie(person), agencyId);
        // Gama (suggestion waiting) first, then the names; Beta would be first if the delay leaked.
        expect(data.map((item) => item.id), person.email).toEqual([ids.gama, ids.alfa, ids.beta, ids.delta]);
      }
    });

    it('leaves the alphabetical sort alone even for who reads Conteúdo', async () => {
      const { agencyId, people, ids } = await world();
      const { data } = await getList(await loginCookie(people.admin), agencyId, '?sort=name:asc');
      expect(data.map((item) => item.id)).toEqual([ids.alfa, ids.beta, ids.delta, ids.gama]);
    });

    it('does not count the conversation of a post as a suggestion waiting, on the card nor on the detail summary', async () => {
      const { agencyId, people, ids } = await world();
      const cookie = await loginCookie(people.admin);
      const { data } = await getList(cookie, agencyId);
      const byId = new Map(data.map((item) => [item.id, item]));
      expect(byId.get(ids.delta)?.threadsAwaitingAgency).toBe(0);
      expect(byId.get(ids.gama)?.threadsAwaitingAgency).toBe(1);

      const detail = await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${ids.delta}`, headers: { ...origin, cookie } });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().summary).toMatchObject({ threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0 });
      const detailGama = await app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/clients/${ids.gama}`, headers: { ...origin, cookie } });
      expect(detailGama.json().summary).toMatchObject({ threadsAwaitingAgency: 1 });
    });

    it('gives an archived client its numbers too, and the late one comes first in the archived list as in the active one', async () => {
      const agencyId = await createAgency();
      const admin = await addMember(agencyId, presetRoleIds.admin, 'archived');
      const zeta = await createClient(agencyId, 'Zeta Arquivado', 'archived');
      const alfa = await createClient(agencyId, 'Alfa Arquivado', 'archived');
      await seedContent(zeta, admin.id, 'in_production', '2026-01-10');
      const { data } = await getList(await loginCookie(admin), agencyId, '?status=archived');
      expect(data.map((item) => item.id)).toEqual([zeta, alfa]);
      expect(data[0]?.contentIndicators).toEqual({ pending: 1, inReview: 0, overdue: 1, adjusting: 0, dueSoon: 0 });
      expect(data[1]?.contentIndicators).toEqual({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 0 });
    });

    it('counts a client of the agency in the URL only, for a caller who belongs to two agencies', async () => {
      const { agencyId, people, ids } = await world();
      const other = await world();
      await owner.knex('agency_memberships').insert({ agency_id: other.agencyId, user_id: people.admin.id, role_id: presetRoleIds.admin });
      const { data } = await getList(await loginCookie(people.admin), agencyId);
      expect(data.map((item) => item.id).sort()).toEqual(Object.values(ids).sort());
      expect(data.find((item) => item.id === ids.beta)?.contentIndicators).toEqual({ pending: 3, inReview: 1, overdue: 3, adjusting: 1, dueSoon: 3 });
    });
  });

  describe('the São Paulo day of "atrasado" and "prazo em dois dias", at fixed instants', () => {
    const setup = async () => {
      const agencyId = await createAgency();
      const admin = await addMember(agencyId, presetRoleIds.admin, 'admin');
      const client = await createClient(agencyId, 'Cliente do dia');
      // Planned on the 10th, 11th, 12th, 13th and 15th of October 2026; none on the 14th, so a window that
      // starts a day late or ends a day early (or reads the UTC day) changes the count. The published and
      // the cancelled of the 12th are never counted.
      for (const day of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-15']) {
        await seedContent(client, admin.id, 'in_production', day);
      }
      await seedContent(client, admin.id, 'published', '2026-10-12');
      await seedContent(client, admin.id, 'cancelled', '2026-10-12');
      return { agencyId, admin };
    };

    it('01:30Z is still the evening before in São Paulo: the day before is late, the day itself and the two after are due soon', async () => {
      const { agencyId, admin } = await setup();
      // 2026-10-12T01:30Z is 2026-10-11 22:30 in São Paulo. A day taken in UTC would be the 12th: two late
      // and the 12th and 13th due soon.
      expect(await listAsOf(admin.id, agencyId, '2026-10-12T01:30:00.000Z')).toEqual([{ overdue: 1, dueSoon: 3 }]);
    });

    it('the day turns at 03:00Z, the midnight of São Paulo: one second before it, today is not late; at it, it is', async () => {
      const { agencyId, admin } = await setup();
      expect(await listAsOf(admin.id, agencyId, '2026-10-12T02:59:59.000Z')).toEqual([{ overdue: 1, dueSoon: 3 }]);
      expect(await listAsOf(admin.id, agencyId, '2026-10-12T03:00:00.000Z')).toEqual([{ overdue: 2, dueSoon: 2 }]);
    });

    it('a day before every planned date has nothing late, and a day long after has everything unfinished late and nothing due soon', async () => {
      const { agencyId, admin } = await setup();
      expect(await listAsOf(admin.id, agencyId, '2026-10-10T02:59:59.000Z')).toEqual([{ overdue: 0, dueSoon: 2 }]);
      expect(await listAsOf(admin.id, agencyId, '2027-01-01T12:00:00.000Z')).toEqual([{ overdue: 5, dueSoon: 0 }]);
    });
  });
});
