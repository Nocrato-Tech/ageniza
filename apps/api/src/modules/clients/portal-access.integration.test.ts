import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type FakeEmailSender,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import type { DatabaseClient } from '@ageniza/database';

// Issue #711: "Adicionar pessoa" and the link of the access to the account at the login. A person of the portal is an access given
// to an e-mail address; the list never says whether an address has an account, and the account takes the access only when its
// address is verified and it enters. Every permission is held alone by a custom role, and the person of two sides (a collaborator who
// is also a person of the portal) and the person of two agencies attack every route again.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: FakeEmailSender;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const clientB1 = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
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
const sessionCount = async (userId: string): Promise<number> =>
  Number((await owner.knex('auth.session').where({ userId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const accessOf = async (clientId: string, email: string) => owner.knex('client_portal_accesses').where({ client_id: clientId, email }).first();
const accessCount = async (clientId: string): Promise<number> =>
  Number((await owner.knex('client_portal_accesses').where({ client_id: clientId }).count<{ count: string }[]>('id as count'))[0]?.count ?? 0);
const freshEmail = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@portal-access.test`;

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const makeUser = async (key: string, name: string, options: { email?: string } = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `pa-${key.toLowerCase()}`, name, ...options });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

const welcomes = async (to: string) => {
  await app.emailService.drain();
  return sender.sent.filter((message) => message.to === to && message.template === 'client-portal-welcome');
};

describe('CLIENTS portal access by e-mail (#711)', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['ownerUser', 'Dona da Agência'], ['manager', 'Marta Gestora'], ['inviteOnly', 'Só Convida'],
      ['removeOnly', 'Só Remove'], ['dualBare', 'Duda Dupla Sem Papel'], ['crossDual', 'Cris Dupla de Duas Agências'], ['otherAdmin', 'Admin da Outra']
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
      { id: agencyA, name: 'Acesso Agência A & Co.', owner_user_id: users.ownerUser!.id },
      { id: agencyB, name: 'Acesso Agência B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.manager!.id, role_id: roleId('account_manager') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: await customRole('cliente.convidar_usuario') },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: await customRole('cliente.remover_usuario') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: 'Padaria Central <A1>' },
      { id: clientA2, agency_id: agencyA, name: 'Outro Cliente A2' },
      { id: clientB1, agency_id: agencyB, name: 'Cliente B1' }
    ]);
    // The two people of two sides hold a portal link to the client of agency A.
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.crossDual!.id }
    ]);
    for (const key of ['admin', 'ownerUser', 'manager', 'inviteOnly', 'removeOnly', 'dualBare', 'crossDual', 'otherAdmin']) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2, clientB1];
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

  describe('POST .../members (Adicionar pessoa)', () => {
    it('gives the access at once, with no account, and sends the welcome e-mail with the link to the sign-in screen', async () => {
      const email = freshEmail('maria');
      const response = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: `  ${email.toUpperCase()}  ` });
      expect(response.statusCode).toBe(201);
      const row = await accessOf(clientA1, email);
      expect(row).toMatchObject({ user_id: null, status: 'active', generation: 1 });
      expect(response.json()).toEqual({
        accessId: row.id, name: null, email, status: 'active', entered: false, since: new Date(row.created_at).toISOString()
      });

      const [mail] = await welcomes(email);
      expect(mail).toBeDefined();
      expect(mail!.subject).toBe('Você tem acesso ao portal no Ageniza');
      expect(mail!.text).toContain('Padaria Central <A1>');
      expect(mail!.text).toContain('Acesso Agência A & Co.');
      expect(mail!.text).toContain(`${TEST_APP_PUBLIC_URL}/entrar`);
      // Nothing to accept: the mail carries no token and no expiry.
      expect(mail!.text).not.toMatch(/token|expira/i);
      expect(mail!.html).toContain('Padaria Central &lt;A1&gt;');
      expect(await owner.knex('client_memberships').where({ portal_access_id: row.id })).toEqual([]);
    });

    it('answers 409 to an address that already has the access, and writes and sends nothing more', async () => {
      const email = freshEmail('repetida');
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).statusCode).toBe(201);
      const before = await accessCount(clientA1);
      const again = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: email.toUpperCase() });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('ACCESS_EXISTS');
      expect(await accessCount(clientA1)).toBe(before);
      expect(await welcomes(email)).toHaveLength(1);
    });

    it('reactivates the row of a removed address, with the generation the removal left, and welcomes the person again', async () => {
      const email = freshEmail('volta');
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin)).statusCode).toBe(200);
      expect(await accessOf(clientA1, email)).toMatchObject({ status: 'removed', generation: 2 });

      const again = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      expect(again.statusCode).toBe(201);
      expect(again.json()).toMatchObject({ accessId: added.accessId, status: 'active' });
      expect(await accessOf(clientA1, email)).toMatchObject({ id: added.accessId, status: 'active', generation: 2 });
      expect(await owner.knex('client_portal_accesses').where({ client_id: clientA1, email }).count<{ count: string }[]>('id as count')).toEqual([{ count: '1' }]);
      expect(await welcomes(email)).toHaveLength(2);
    });

    it('never says, in the response or in the list, whether the address has an account, and never links it', async () => {
      const verified = await makeUser('withAccount', 'Pessoa Com Conta');
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [verified.id]);
      const without = freshEmail('semconta');
      const withAccount = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: verified.email });
      const withoutAccount = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email: without });

      for (const response of [withAccount, withoutAccount]) {
        expect(response.statusCode).toBe(201);
        expect(Object.keys(response.json()).sort()).toEqual(['accessId', 'email', 'entered', 'name', 'since', 'status']);
        expect(response.json()).toMatchObject({ name: null, entered: false });
      }
      expect(await accessOf(clientA1, verified.email)).toMatchObject({ user_id: null });
      expect(await owner.knex('client_memberships').where({ client_id: clientA1, user_id: verified.id })).toEqual([]);

      const listed = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin)).json().data as Array<{ email: string; name: string | null; entered: boolean }>;
      const byEmail = (email: string) => listed.find((item) => item.email === email);
      expect(byEmail(verified.email)).toMatchObject({ name: null, entered: false });
      expect(byEmail(without)).toMatchObject({ name: null, entered: false });
      expect(JSON.stringify(listed)).not.toContain('Pessoa Com Conta');
    });

    it('adds a person who is already in the portal of another client of the agency, and leaves that access as it is', async () => {
      const email = freshEmail('outro-cliente');
      const person = await makeUser('inOtherClient', 'Em Outro Cliente', { email });
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: person.id });
      const before = await accessOf(clientA2, email);

      const response = await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      expect(response.statusCode).toBe(201);
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null, status: 'active' });
      expect(await accessOf(clientA2, email)).toEqual(before);
    });

    it('is refused to every caller without cliente.convidar_usuario, and answers 404 across agencies, writing nothing', async () => {
      const email = freshEmail('negada');
      for (const key of ['manager', 'removeOnly', 'dualBare']) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies[key], { email })).statusCode, key).toBe(403);
      }
      expect((await call('POST', membersUrl(agencyA, clientA1), undefined, { email })).statusCode).toBe(401);
      // The collaborator of another agency who is also a person of this client's portal: the agency of the URL is not theirs.
      for (const key of ['crossDual', 'otherAdmin']) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies[key], { email })).statusCode, key).toBe(404);
      }
      expect((await call('POST', membersUrl(agencyA, clientB1), cookies.admin, { email })).statusCode).toBe(404);
      expect((await call('POST', membersUrl(agencyA, randomUUID()), cookies.admin, { email })).statusCode).toBe(404);
      expect((await call('POST', membersUrl(agencyA, 'not-a-uuid'), cookies.admin, { email })).statusCode).toBe(404);
      expect(await accessOf(clientA1, email)).toBeUndefined();
      expect(await welcomes(email)).toHaveLength(0);

      // The permission alone, and the owner, who has no membership row, are enough.
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.inviteOnly, { email: freshEmail('so-convida') })).statusCode).toBe(201);
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.ownerUser, { email: freshEmail('dona') })).statusCode).toBe(201);
    });

    it('refuses a body that is not exactly an address', async () => {
      const before = await accessCount(clientA1);
      for (const payload of [{}, { email: 'sem-arroba' }, { email: '' }, { email: freshEmail('x'), role: 'admin' }, { email: 42 }, { email: `${'a'.repeat(330)}@x.test` }]) {
        expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin, payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect((await call('POST', membersUrl(agencyA, clientA1), cookies.admin)).statusCode).toBe(400);
      expect(await accessCount(clientA1)).toBe(before);
    });

    it('keeps the access when the e-mail cannot be delivered, says so with a 502, and the same address is then 409', async () => {
      const failing = await buildTestApp({ sender: createFakeEmailSender(async () => { throw new Error('smtp is down'); }) });
      try {
        const email = freshEmail('smtp');
        const adminCookie = await (async () => {
          const response = await failing.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: users.admin!.email, password: users.admin!.password } });
          return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
        })();
        const response = await failing.app.inject({
          method: 'POST', url: membersUrl(agencyA, clientA1), headers: { ...origin, cookie: adminCookie }, payload: { email }
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(await accessOf(clientA1, email)).toMatchObject({ status: 'active', user_id: null });
        const again = await failing.app.inject({
          method: 'POST', url: membersUrl(agencyA, clientA1), headers: { ...origin, cookie: adminCookie }, payload: { email }
        });
        expect(again.statusCode).toBe(409);
      } finally {
        await failing.close();
      }
    });

    it('ends the sessions of the account that lost the address, as any removal does, and not those of the caller', async () => {
      const former = await makeUser('former', 'Conta que Mudou');
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [former.id]);
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: former.id });
      const cookie = await login(former);
      expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(200);
      const access = await owner.knex('client_portal_accesses').where({ client_id: clientA2, user_id: former.id }).first();
      await app.pool.query('update auth."user" set email = $2 where id = $1', [former.id, freshEmail('mudou')]);
      const adminSessions = await sessionCount(users.admin!.id);

      const response = await call('POST', membersUrl(agencyA, clientA2), cookies.admin, { email: access.email });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ accessId: access.id, entered: false, name: null });
      expect(await sessionCount(former.id)).toBe(0);
      expect((await call('GET', `/clients/${clientA2}`, cookie)).statusCode).toBe(401);
      expect(await sessionCount(users.admin!.id)).toBe(adminSessions);
      expect(await owner.knex('client_memberships').where({ client_id: clientA2, user_id: former.id }).first('status')).toEqual({ status: 'removed' });
    });
  });

  describe('the link at the login', () => {
    it('gives the portal to an account whose address is verified, when it loads its contexts, and to nobody before', async () => {
      const email = freshEmail('entra');
      const person = await makeUser('enters', 'Pessoa que Entra', { email });
      // An account with no context at all cannot sign in; this one is already a person of the portal of another client.
      await owner.knex('client_memberships').insert({ client_id: clientA2, user_id: person.id });
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect(added.entered).toBe(false);

      // Unconfirmed: logged in, and the portal does not appear.
      const unconfirmed = await login(person);
      const before = (await call('GET', '/me/contexts', unconfirmed)).json();
      expect(before.contexts.filter((context: { type: string }) => context.type === 'client')).toEqual([expect.objectContaining({ clientId: clientA2 })]);
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null });
      expect((await call('GET', `/clients/${clientA1}`, unconfirmed)).statusCode).toBe(404);

      // Confirmed: the next time it loads its contexts, the portal is there.
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      const after = (await call('GET', '/me/contexts', unconfirmed)).json();
      expect(after.contexts.map((context: { clientId: string }) => context.clientId).sort()).toEqual([clientA1, clientA2].sort());
      expect(after.contexts).toContainEqual(expect.objectContaining({ type: 'client', clientId: clientA1, clientName: 'Padaria Central <A1>' }));
      expect(await accessOf(clientA1, email)).toMatchObject({ id: added.accessId, user_id: person.id });
      expect((await call('GET', `/clients/${clientA1}`, unconfirmed)).statusCode).toBe(200);

      // The list now shows the name of the account, and the address as it was recorded.
      const listed = (await call('GET', membersUrl(agencyA, clientA1), cookies.admin)).json().data.find((item: { accessId: string }) => item.accessId === added.accessId);
      expect(listed).toMatchObject({ name: 'Pessoa que Entra', email, entered: true });
    });

    it('lets a verified account with no context but an access sign in, because the link comes before the count of contexts', async () => {
      const email = freshEmail('primeira');
      const person = await makeUser('firstLogin', 'Primeiro Acesso', { email });
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email });
      const cookie = await login(person);
      expect((await call('GET', '/me/contexts/resolve', cookie)).json()).toMatchObject({ decision: 'enter', context: { type: 'client', clientId: clientA1 } });
    });

    it('does not link an access that was removed before the account entered, and shows the person as removed', async () => {
      const email = freshEmail('removida');
      const person = await makeUser('removedBeforeEntering', 'Removida Antes', { email });
      await app.pool.query('update auth."user" set "emailVerified" = true where id = $1', [person.id]);
      const added = (await call('POST', membersUrl(agencyA, clientA1), cookies.admin, { email })).json();
      expect((await call('POST', `${membersUrl(agencyA, clientA1)}/${added.accessId}/remove`, cookies.admin)).json()).toMatchObject({ status: 'removed', entered: false });
      expect(await accessOf(clientA1, email)).toMatchObject({ user_id: null, status: 'removed' });
    });
  });
});
