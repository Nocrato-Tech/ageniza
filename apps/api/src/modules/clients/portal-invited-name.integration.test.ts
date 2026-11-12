import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';
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

// Decision 2026-11-11: the agency types the name of the person it adds to the portal, and that name is what the list shows until the
// person enters; after that the account's own name shows. It revises the anti-oracle rule of 2026-10-27 without opening it: the typed
// name is a value of the access and is never read from an account, so an address that has an account and one that has none look the same.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const extraClientIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

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

const membersUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/members`;
const accessOf = (clientId: string, email: string) => owner.knex('client_portal_accesses').where({ client_id: clientId, email }).first();
const accessCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_portal_accesses').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const freshEmail = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@invited-name.test`;
const errorOf = (reply: Reply): { code?: string; details?: { issues?: Array<{ path: string }> } } => {
  const body = reply.json();
  return typeof body.error === 'object' && body.error !== null ? body.error : body;
};

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const makeUser = async (key: string, name: string, options: { email?: string; emailVerified?: boolean } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `in-${key.toLowerCase()}`, name, ...options });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

const newClient = async (label: string, agencyId = agencyA): Promise<string> => {
  const id = randomUUID();
  extraClientIds.push(id);
  await owner.knex('clients').insert({ id, agency_id: agencyId, name: `Nome ${label} ${id}` });
  return id;
};

const listOf = async (who: string, clientId: string, agencyId = agencyA, query = 'pageSize=100'): Promise<Array<{ accessId: string; name: string | null; email: string; entered: boolean }>> =>
  (await call('GET', `${membersUrl(agencyId, clientId)}?${query}`, cookies[who])).json().data;

describe('CLIENTES the name the agency types for a person of the portal (decision 2026-11-11)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    app = await buildTestApp({ sender: createFakeEmailSender() });

    for (const [key, name] of [
      ['ownerUser', 'Dona da Agência'], ['admin', 'Adriana Admin'], ['inviteOnly', 'Só Convida'], ['removeOnly', 'Só Remove'],
      ['otherAdmin', 'Admin da Outra'], ['portalOne', 'Ana do Portal']
    ] as const) await makeUser(key, name);

    const roles = await owner.knex('roles').whereNull('agency_id').select('id', 'key');
    const roleId = (key: string): string => roles.find((candidate) => candidate.key === key)!.id as string;
    const customRole = async (...permissions: string[]): Promise<string> => {
      const id = randomUUID();
      createdRoleIds.push(id);
      await owner.knex('roles').insert({ id, agency_id: agencyA, key: `only-${id}`, name: `Só ${permissions.join('+')}`, is_system: false });
      await owner.knex('role_permissions').insert(permissions.map((permission) => ({ role_id: id, permission_key: permission })));
      return id;
    };

    await owner.knex('agencies').insert([
      { id: agencyA, name: 'Nome Digitado Agência A', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Nome Digitado Agência B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: await customRole('cliente.convidar_usuario') },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: await customRole('cliente.remover_usuario') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: 'Cliente A1 do nome digitado' },
      { id: clientA2, agency_id: agencyA, name: 'Cliente A2 do nome digitado' },
      { id: clientB1, agency_id: agencyB, name: 'Cliente B1 do nome digitado' }
    ]);
    await owner.knex('client_memberships').insert({ client_id: clientA1, user_id: users.portalOne!.id });
    for (const key of Object.keys(users)) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2, clientB1, ...extraClientIds];
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('invitations').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('audit.events').whereIn('agency_id', [agencyA, agencyB]).delete();
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

  describe('what the agency typed', () => {
    it('shows it, trimmed, in the answer and in the list before the person enters, and shows no name when none was typed', async () => {
      const client = await newClient('digitado');
      const typed = freshEmail('debora');
      const added = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: typed, name: '  Débora Lima  ' });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ name: 'Débora Lima', email: typed, entered: false, status: 'active' });
      expect(await accessOf(client, typed)).toMatchObject({ invited_name: 'Débora Lima', user_id: null });

      const bare = freshEmail('sem-nome');
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email: bare })).json()).toMatchObject({ name: null });
      const blank = freshEmail('em-branco');
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email: blank, name: '   ' })).json()).toMatchObject({ name: null });
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email: freshEmail('vazio'), name: '' })).json()).toMatchObject({ name: null });
      expect(await accessOf(client, blank)).toMatchObject({ invited_name: null });

      const listed = await listOf('admin', client);
      expect(listed.find((item) => item.email === typed)).toMatchObject({ name: 'Débora Lima', entered: false });
      expect(listed.find((item) => item.email === bare)).toMatchObject({ name: null, entered: false });
    });

    it('orders the list by the shown name, the typed one before the entry and the address when none, folded and compared byte by byte', async () => {
      const client = await newClient('ordem');
      const mails = { zelia: freshEmail('a-zelia'), clara: freshEmail('z-clara'), bare: freshEmail('m-endereco'), accented: freshEmail('b-acento') };
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: mails.zelia, name: 'Zélia' });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: mails.clara, name: 'clara' });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: mails.bare });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: mails.accented, name: 'Álvaro' });

      // "álvaro", "clara", the address "m-endereco-…", then "zélia": the key is the shown name, not the address, and accent and case do not count.
      expect((await listOf('admin', client)).map((item) => item.email)).toEqual([mails.accented, mails.clara, mails.bare, mails.zelia]);
      const firstPage = (await call('GET', `${membersUrl(agencyA, client)}?pageSize=2`, cookies.admin)).json();
      const secondPage = (await call('GET', `${membersUrl(agencyA, client)}?pageSize=2&page=2`, cookies.admin)).json();
      expect([...firstPage.data, ...secondPage.data].map((item: { email: string }) => item.email)).toEqual([mails.accented, mails.clara, mails.bare, mails.zelia]);
      expect(firstPage.meta.totalItems).toBe(4);
    });

    it('takes up to 120 characters of one visible line, and refuses the rest with a 400 that names the field and writes nothing', async () => {
      const client = await newClient('limites');
      const before = await accessCount(client);
      for (const name of ['a'.repeat(121), 'ç'.repeat(121), 'Duas\nlinhas', 'Tab\taqui', 'Sino\u0007aqui', 'Nulo\u0000aqui', 'Oculto​aqui', 'Bidi‮aqui', '!!!', 5, ['Ana'], { first: 'Ana' }]) {
        const label = JSON.stringify(name)?.slice(0, 24);
        const refused = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: freshEmail('ruim'), name });
        expect(refused.statusCode, label).toBe(400);
        expect(errorOf(refused).code, label).toBe('VALIDATION_ERROR');
        expect(errorOf(refused).details?.issues?.[0]?.path, label).toBe('name');
        expect(JSON.stringify(refused.json()), label).not.toMatch(/23514|_check|app_private|violates/i);
      }
      expect(await accessCount(client)).toBe(before);
      const accepted = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: freshEmail('limite'), name: 'a'.repeat(120) });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.json().name).toHaveLength(120);
    });

    it('is written by who may add people, and by nobody else, and is written for no other client than the one of the route', async () => {
      const client = await newClient('permissao');
      const email = freshEmail('permitida');
      expect((await call('POST', membersUrl(agencyA, client), cookies.inviteOnly, { email, name: 'Permitida' })).statusCode).toBe(201);
      expect((await accessOf(client, email))?.invited_name).toBe('Permitida');

      const before = await accessCount(client);
      for (const attempt of [
        call('POST', membersUrl(agencyA, client), cookies.removeOnly, { email: freshEmail('a'), name: 'Sem permissão' }),
        call('POST', membersUrl(agencyA, client), cookies.portalOne, { email: freshEmail('b'), name: 'Portal' }),
        call('POST', membersUrl(agencyA, client), cookies.otherAdmin, { email: freshEmail('c'), name: 'Outra agência' }),
        call('POST', membersUrl(agencyB, client), cookies.otherAdmin, { email: freshEmail('d'), name: 'Outra agência' }),
        call('POST', membersUrl(agencyA, client), undefined, { email: freshEmail('e'), name: 'Sem sessão' })
      ]) expect([401, 403, 404]).toContain((await attempt).statusCode);
      expect(await accessCount(client)).toBe(before);

      const archived = await newClient('arquivado');
      await owner.knex('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
      expect((await call('POST', membersUrl(agencyA, archived), cookies.admin, { email: freshEmail('f'), name: 'Arquivado' })).statusCode).toBe(409);
      expect(await accessCount(archived)).toBe(0);
    });

    it('may be updated by adding a removed address again, is kept when none is typed, and is never overwritten on an active access', async () => {
      const client = await newClient('readicionar');
      const email = freshEmail('volta');
      const first = (await call('POST', membersUrl(agencyA, client), cookies.admin, { email, name: 'Primeiro' })).json();
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email, name: 'Terceiro' })).statusCode).toBe(409);
      expect((await accessOf(client, email))?.invited_name).toBe('Primeiro');

      expect((await call('POST', `${membersUrl(agencyA, client)}/${first.accessId}/remove`, cookies.admin)).statusCode).toBe(200);
      const again = await call('POST', membersUrl(agencyA, client), cookies.admin, { email, name: 'Segundo' });
      expect(again.statusCode).toBe(201);
      expect(again.json()).toMatchObject({ accessId: first.accessId, name: 'Segundo', status: 'active' });
      expect((await accessOf(client, email))?.invited_name).toBe('Segundo');

      await call('POST', `${membersUrl(agencyA, client)}/${first.accessId}/remove`, cookies.admin);
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email })).json()).toMatchObject({ name: 'Segundo' });
      expect((await call('POST', membersUrl(agencyA, client), cookies.admin, { email, name: 'Quarto' })).statusCode).toBe(409);
      expect((await accessOf(client, email))?.invited_name).toBe('Segundo');
    });
  });

  describe('the typed name is not an oracle of accounts', () => {
    const verified = async (key: string, name: string): Promise<TestUserFixture> => {
      const user = await makeUser(key, name);
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [user.id]);
      // A context of its own (the portal of another client) is what lets the account sign in and load its contexts.
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: user.id });
      return user;
    };
    const shapeOf = (member: Record<string, unknown>): Record<string, unknown> => ({ ...member, accessId: 'x', email: 'x', since: 'x' });

    it('shows the typed name, never the account name, for an address that has an account, and the same for one that has none', async () => {
      const client = await newClient('oraculo');
      const account = await verified('oracleOne', 'Nome Real da Conta Um');
      const noAccount = freshEmail('sem-conta');

      const withAccount = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: account.email, name: 'Digitado Um' });
      const withoutAccount = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: noAccount, name: 'Digitado Um' });
      expect(withAccount.statusCode).toBe(201);
      expect(shapeOf(withAccount.json())).toEqual(shapeOf(withoutAccount.json()));
      expect(withAccount.json()).toMatchObject({ name: 'Digitado Um', entered: false });
      expect(JSON.stringify(withAccount.json())).not.toContain('Nome Real da Conta Um');

      const listed = await listOf('admin', client);
      expect(listed.map((item) => item.name)).toEqual(['Digitado Um', 'Digitado Um']);
      expect(JSON.stringify(listed)).not.toContain('Nome Real da Conta Um');
    });

    it('shows no name for an address that has an account when none was typed, exactly like an address with none', async () => {
      const client = await newClient('oraculo-sem-nome');
      const account = await verified('oracleTwo', 'Nome Real da Conta Dois');
      const noAccount = freshEmail('sem-conta');
      const withAccount = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: account.email });
      const withoutAccount = await call('POST', membersUrl(agencyA, client), cookies.admin, { email: noAccount });
      expect(shapeOf(withAccount.json())).toEqual(shapeOf(withoutAccount.json()));
      expect(withAccount.json()).toMatchObject({ name: null, entered: false });
      expect(JSON.stringify(await listOf('admin', client))).not.toContain('Nome Real da Conta Dois');
    });

    it('does not let the order tell the agency the account name: it follows the typed name or the address, before and after the link of the account', async () => {
      const client = await newClient('oraculo-ordem');
      // The account name would sort first ("0 ..."), and the address would sort last ("zz-...").
      const account = await verified('oracleOrder', '0 Nome Que Iria Primeiro');
      const accountEmail = account.email.replace(/^[^@]+/, `zz-${randomUUID().slice(0, 6)}`);
      await app.pool.query('update auth."user" set email = $1 where id = $2', [accountEmail, account.id]);
      const others = [freshEmail('b-outra'), freshEmail('c-outra')];
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: others[0]! });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: accountEmail });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: others[1]! });
      const before = (await listOf('admin', client)).map((item) => item.email);
      expect(before).toEqual([...others, accountEmail]);

      const cookie = await login({ ...account, email: accountEmail });
      expect((await call('GET', '/me/contexts', cookie)).statusCode).toBe(200);
      expect(await accessOf(client, accountEmail)).toMatchObject({ user_id: account.id, first_entered_at: null });
      expect((await listOf('admin', client)).map((item) => item.email)).toEqual(before);
      expect((await listOf('admin', client)).find((item) => item.email === accountEmail)).toMatchObject({ name: null, entered: false });
    });

    it('shows the account name once the person entered this portal, and the typed name no longer shows nor orders', async () => {
      const client = await newClient('oraculo-entrada');
      const account = await verified('oracleEntered', 'Conta Que Entrou');
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: account.email, name: 'Zzz Digitado' });
      const cookie = await login(account);
      await call('GET', '/me/contexts', cookie);
      expect((await listOf('admin', client))[0]).toMatchObject({ name: 'Zzz Digitado', entered: false });

      expect((await call('GET', `/clients/${client}`, cookie)).statusCode).toBe(200);
      const [entered] = await listOf('admin', client);
      expect(entered).toMatchObject({ name: 'Conta Que Entrou', entered: true });
      expect(JSON.stringify(await listOf('admin', client))).not.toContain('Zzz Digitado');
      expect(await accessOf(client, account.email)).toMatchObject({ invited_name: 'Zzz Digitado' });
    });

    it('orders by the account name once the person entered, and by the typed name of the ones who did not', async () => {
      const client = await newClient('ordem-apos-entrada');
      const account = await verified('orderEntered', 'Aaa Conta Que Entrou');
      const other = freshEmail('outra-pessoa');
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: account.email, name: 'Zzz Digitado' });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: other, name: 'Mmm Digitado' });
      expect((await listOf('admin', client)).map((item) => item.email)).toEqual([other, account.email]);

      const cookie = await login(account);
      await call('GET', '/me/contexts', cookie);
      expect((await call('GET', `/clients/${client}`, cookie)).statusCode).toBe(200);
      expect((await listOf('admin', client)).map((item) => item.email)).toEqual([account.email, other]);
    });

    it('keeps the typed name when the account of a person who entered no longer exists, and shows no name when none was typed', async () => {
      const client = await newClient('conta-apagada');
      const typed = await verified('deletedTyped', 'Conta Apagada Digitada');
      const bare = await verified('deletedBare', 'Conta Apagada Sem Nome');
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: typed.email, name: 'Nome Digitado Que Fica' });
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email: bare.email });
      for (const user of [typed, bare]) {
        const cookie = await login(user);
        await call('GET', '/me/contexts', cookie);
        expect((await call('GET', `/clients/${client}`, cookie)).statusCode).toBe(200);
      }
      expect((await listOf('admin', client)).map((item) => item.name)).toEqual(['Conta Apagada Digitada', 'Conta Apagada Sem Nome']);

      for (const user of [typed, bare]) {
        await owner.knex('user_context_preferences').where({ user_id: user.id }).delete();
        await owner.knex('client_memberships').where({ user_id: user.id }).delete();
        await app.pool.query('delete from auth."user" where id = $1', [user.id]);
      }
      expect(await accessOf(client, typed.email)).toMatchObject({ user_id: null, invited_name: 'Nome Digitado Que Fica' });
      const listed = await listOf('admin', client);
      expect(listed.find((item) => item.email === typed.email)).toMatchObject({ name: 'Nome Digitado Que Fica', entered: false });
      expect(listed.find((item) => item.email === bare.email)).toMatchObject({ name: null, entered: false });
    });

    it('is a value of the access: the same address in another client of the agency, or of another agency, has its own name', async () => {
      const first = await newClient('mesmo-endereco-um');
      const second = await newClient('mesmo-endereco-dois');
      const foreign = await newClient('mesmo-endereco-fora', agencyB);
      const email = freshEmail('compartilhado');
      await call('POST', membersUrl(agencyA, first), cookies.admin, { email, name: 'Nome do Primeiro' });
      await call('POST', membersUrl(agencyA, second), cookies.admin, { email });
      await call('POST', membersUrl(agencyB, foreign), cookies.otherAdmin, { email, name: 'Nome da Outra Agência' });

      expect((await listOf('admin', first)).find((item) => item.email === email)).toMatchObject({ name: 'Nome do Primeiro' });
      expect((await listOf('admin', second)).find((item) => item.email === email)).toMatchObject({ name: null });
      expect((await listOf('otherAdmin', foreign, agencyB)).find((item) => item.email === email)).toMatchObject({ name: 'Nome da Outra Agência' });
      for (const [who, clientId, agencyId, forbidden] of [
        ['admin', first, agencyA, 'Nome da Outra Agência'],
        ['otherAdmin', foreign, agencyB, 'Nome do Primeiro']
      ] as const) expect(JSON.stringify(await listOf(who, clientId, agencyId))).not.toContain(forbidden);
    });

    it('does not reach another agency, a person of the portal or a visitor, and does not reach the portal pages', async () => {
      const client = await newClient('vazamento');
      const email = freshEmail('guardada');
      await call('POST', membersUrl(agencyA, client), cookies.admin, { email, name: 'Nome Só da Agência' });
      await owner.knex('client_memberships').insert({ client_id: client, user_id: users.portalOne!.id });

      for (const attempt of [
        call('GET', membersUrl(agencyA, client), cookies.otherAdmin),
        call('GET', membersUrl(agencyB, client), cookies.otherAdmin),
        call('GET', membersUrl(agencyA, client), cookies.portalOne),
        call('GET', membersUrl(agencyA, client), cookies.removeOnly),
        call('GET', membersUrl(agencyA, client), undefined)
      ]) {
        const reply = await attempt;
        expect([401, 403, 404]).toContain(reply.statusCode);
        expect(JSON.stringify(reply.json())).not.toContain('Nome Só da Agência');
      }
      for (const url of [`/clients/${client}`, `/clients/${client}/brand-study`, `/clients/${client}/material-requests`, `/clients/${client}/threads?materialRequest=true`]) {
        const reply = await call('GET', url, cookies.portalOne);
        expect(JSON.stringify(reply.json()), url).not.toContain('Nome Só da Agência');
      }
      expect(JSON.stringify((await call('GET', `/agencies/${agencyA}/clients/${client}`, cookies.admin)).json())).not.toContain('Nome Só da Agência');
    });
  });
});
