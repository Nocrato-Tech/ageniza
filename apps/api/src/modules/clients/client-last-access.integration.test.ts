import { createHash, randomBytes, randomUUID } from 'node:crypto';

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

// Decision 2026-11-10 ("último acesso ao portal por cliente") and the one that follows it ("quem só abriu o link de aprovação ainda não
// entrou com a conta"): the list of people of the portal carries `lastEnteredAt`, written by the database alone. Whoever already reads
// the list reads it; a person of the portal, a collaborator without the permission and another agency read nothing, and every person
// of two sides (`dualBare`, `crossDual`) is asked again.
const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: FakeEmailSender;

const agencyA = randomUUID();
const agencyB = randomUUID();
const clientA1 = randomUUID();
const clientA2 = randomUUID();
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdContentIds: string[] = [];
const users: Record<string, TestUserFixture> = {};
const cookies: Record<string, string> = {};

interface Reply {
  readonly statusCode: number;
  readonly cookies: ReadonlyArray<{ name: string; value: string }>;
  json<T = any>(): T; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over untyped JSON
}

const call = async (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown, remoteAddress?: string): Promise<Reply> =>
  (await app.app.inject({
    method,
    url,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  })) as unknown as Reply;

const membersUrl = (agencyId: string, clientId: string): string => `/agencies/${agencyId}/clients/${clientId}/members`;
const freshEmail = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@last-access.test`;

const login = async (user: TestUserFixture): Promise<string> => {
  const response = await call('POST', '/auth/login', undefined, { email: user.email, password: user.password });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
};

const makeUser = async (key: string, name: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: `la-${key.toLowerCase()}`, name });
  createdUserIds.push(user.id);
  users[key] = user;
  return user;
};

/** An access nobody has entered, as "Adicionar pessoa" leaves it, but with no event, so the minute of the person is free. */
const seedAccess = async (clientId: string, email = freshEmail('pessoa')): Promise<{ id: string; email: string }> => {
  const id = randomUUID();
  await owner.knex('client_portal_accesses').insert({ id, client_id: clientId, email });
  return { id, email };
};

const accessRow = (id: string) => owner.knex('client_portal_accesses').where({ id }).first();

/** What the database stamped, as the list prints it: only the database writes the column, so a test reads it and never sets it. */
const lastEnteredOf = async (accessId: string): Promise<string | null> => {
  const value = (await accessRow(accessId)).last_entered_at as Date | null;
  return value === null ? null : value.toISOString();
};

interface Listed {
  readonly accessId: string;
  readonly name: string | null;
  readonly entered: boolean;
  readonly lastEnteredAt: string | null;
}

const listed = async (cookie: string, clientId = clientA1): Promise<Listed[]> => {
  const response = await call('GET', `${membersUrl(agencyA, clientId)}?pageSize=100`, cookie);
  expect(response.statusCode).toBe(200);
  return response.json().data as Listed[];
};

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The link of the approval e-mail for an access: a content awaiting approval, the item of the queue, and the token the e-mail carries. */
const issueApprovalLink = async (accessId: string, clientId: string): Promise<string> => {
  const folder = await owner.knex('media_folders').where({ client_id: clientId, name: 'Imagens', is_default: true }).first('id');
  const contentId = randomUUID();
  createdContentIds.push(contentId);
  await owner.knex('contents').insert({
    id: contentId,
    client_id: clientId,
    title: `Conteúdo ${contentId.slice(0, 8)}`,
    platform: 'instagram',
    format: 'image',
    publish_on: '2026-12-20',
    folder_id: folder.id,
    owner_user_id: users.admin!.id,
    status: 'awaiting_approval'
  });
  const claimToken = randomUUID();
  const queued = await owner.knex.raw<{ rows: Array<{ id: string }> }>(`
    insert into public.notification_queue (type, client_id, recipient_portal_access_id, content_id, send_after, claimed_at, claim_token, attempts)
    values ('content_awaiting_approval', ?, ?, ?, now() - interval '1 minute', now(), ?, 1)
    returning id
  `, [clientId, accessId, contentId, claimToken]);
  const token = randomBytes(32).toString('base64url');
  await owner.knex.raw('select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [[queued.rows[0]!.id], claimToken, sha(token)]);
  return token;
};

describe('CLIENTS the last entry of a person of the portal, as the agency reads it', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });

    for (const [key, name] of [
      ['admin', 'Adriana Admin'], ['inviteOnly', 'Só Convida'], ['removeOnly', 'Só Remove'], ['noPermission', 'Sem Permissão'],
      ['dualBare', 'Duda Dupla Sem Papel'], ['crossDual', 'Cris Dupla de Duas Agências'], ['otherAdmin', 'Admin da Outra'],
      ['portal', 'Ana do Portal'], ['portalSecond', 'Bia do Portal']
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
      { id: agencyA, name: 'Último Acesso A', owner_user_id: null },
      { id: agencyB, name: 'Último Acesso B', owner_user_id: null }
    ]);
    await owner.knex('agency_memberships').insert([
      { agency_id: agencyA, user_id: users.admin!.id, role_id: roleId('admin') },
      { agency_id: agencyA, user_id: users.inviteOnly!.id, role_id: await customRole('cliente.convidar_usuario') },
      { agency_id: agencyA, user_id: users.removeOnly!.id, role_id: await customRole('cliente.remover_usuario') },
      { agency_id: agencyA, user_id: users.noPermission!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyA, user_id: users.dualBare!.id, role_id: await customRole('midia.enviar') },
      { agency_id: agencyB, user_id: users.crossDual!.id, role_id: roleId('admin') },
      { agency_id: agencyB, user_id: users.otherAdmin!.id, role_id: roleId('admin') }
    ]);
    await owner.knex('clients').insert([
      { id: clientA1, agency_id: agencyA, name: 'Último Acesso A1' },
      { id: clientA2, agency_id: agencyA, name: 'Último Acesso A2' }
    ]);
    await owner.knex('client_memberships').insert([
      { client_id: clientA1, user_id: users.portal!.id },
      { client_id: clientA1, user_id: users.portalSecond!.id },
      { client_id: clientA1, user_id: users.dualBare!.id },
      { client_id: clientA1, user_id: users.crossDual!.id }
    ]);
    for (const key of Object.keys(users)) cookies[key] = await login(users[key]!);
  });

  afterAll(async () => {
    const clientIds = [clientA1, clientA2];
    const linkIds = await owner.knex('client_portal_approval_links').whereIn('client_id', clientIds).pluck('id');
    await owner.knex('client_portal_approval_sessions').whereIn('link_id', linkIds).delete();
    await owner.knex('client_portal_approval_link_contents').whereIn('link_id', linkIds).delete();
    await owner.knex('client_portal_approval_links').whereIn('id', linkIds).delete();
    await owner.knex('notification_queue').whereIn('client_id', clientIds).delete();
    await owner.knex('contents').whereIn('id', createdContentIds).delete();
    await owner.knex('media_folders').whereIn('client_id', clientIds).delete();
    await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
    await owner.knex('audit.events').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
    await owner.knex('role_permissions').whereIn('role_id', createdRoleIds).delete();
    await owner.knex('roles').whereIn('id', createdRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('lists null for a person who never entered, and the instant the database stamped for one who did', async () => {
    const never = await seedAccess(clientA1);
    const before = await listed(cookies.admin!);
    expect(before.find((person) => person.accessId === never.id)).toMatchObject({ entered: false, name: null, lastEnteredAt: null });

    expect((await call('GET', `/clients/${clientA1}`, cookies.portal!)).statusCode).toBe(200);
    const access = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: users.portal!.id }).first();
    const stamped = await lastEnteredOf(access.id as string);
    expect(stamped).not.toBeNull();
    expect(access.first_entered_at).not.toBeNull();

    const after = await listed(cookies.admin!);
    expect(after.find((person) => person.accessId === access.id)).toMatchObject({ entered: true, name: 'Ana do Portal', lastEnteredAt: stamped });
    expect(after.find((person) => person.accessId === never.id)).toMatchObject({ lastEnteredAt: null });
    for (const person of after) expect(person.lastEnteredAt === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(person.lastEnteredAt)).toBe(true);
  });

  it('moves the last entry forward at every entry and never moves the first one', async () => {
    const access = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: users.portalSecond!.id }).first();
    expect((await call('GET', `/clients/${clientA1}`, cookies.portalSecond!)).statusCode).toBe(200);
    const first = await accessRow(access.id as string);
    expect((await call('GET', `/clients/${clientA1}`, cookies.portalSecond!)).statusCode).toBe(200);
    const second = await accessRow(access.id as string);

    expect(second.last_entered_at.getTime()).toBeGreaterThan(first.last_entered_at.getTime());
    expect(second.first_entered_at.getTime()).toBe(first.first_entered_at.getTime());
    expect((await listed(cookies.admin!)).find((person) => person.accessId === access.id)?.lastEnteredAt).toBe(second.last_entered_at.toISOString());
  });

  it('is read by whoever reads the list of people, and by nobody else', async () => {
    const access = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: users.portal!.id }).first();
    const stamped = (await lastEnteredOf(access.id as string))!;
    for (const reader of ['admin', 'inviteOnly']) {
      expect((await listed(cookies[reader]!)).find((person) => person.accessId === access.id)?.lastEnteredAt, reader).toBe(stamped);
    }

    // Each of these is refused on the agency route, and nothing of the list, and no instant, comes back with the refusal.
    for (const [who, url] of [
      ['portal', membersUrl(agencyA, clientA1)],
      ['removeOnly', membersUrl(agencyA, clientA1)],
      ['noPermission', membersUrl(agencyA, clientA1)],
      ['dualBare', membersUrl(agencyA, clientA1)],
      ['crossDual', membersUrl(agencyA, clientA1)],
      ['otherAdmin', membersUrl(agencyA, clientA1)],
      ['otherAdmin', membersUrl(agencyB, clientA1)]
    ] as const) {
      const response = await call('GET', url, cookies[who]!);
      expect([403, 404], `${who} ${url}`).toContain(response.statusCode);
      expect(JSON.stringify(response.json()), `${who} ${url}`).not.toContain(stamped);
      expect(JSON.stringify(response.json()), `${who} ${url}`).not.toContain('lastEnteredAt');
    }
  });

  it('never reaches the portal: what a person of the portal reads of its own client carries no last entry', async () => {
    const access = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: users.portal!.id }).first();
    const stamped = (await lastEnteredOf(access.id as string))!;
    for (const who of ['portal', 'dualBare', 'crossDual']) {
      for (const suffix of ['', '/brand-study']) {
        const response = await call('GET', `/clients/${clientA1}${suffix}`, cookies[who]!);
        expect(response.statusCode, `${who}${suffix}`).toBe(200);
        expect(JSON.stringify(response.json()), `${who}${suffix}`).not.toMatch(/lastEnteredAt|last_entered_at/);
        expect(JSON.stringify(response.json()), `${who}${suffix}`).not.toContain(stamped);
      }
    }
  });

  describe('a person who only opened the approval link', () => {
    it('is not "entered" with the account, has the last entry set, and keeps the resend of the welcome', async () => {
      const person = await seedAccess(clientA1);
      const token = await issueApprovalLink(person.id, clientA1);
      expect(await lastEnteredOf(person.id)).toBeNull();

      const exchanged = await call('POST', '/portal-approval/session', undefined, { token }, '198.51.100.77');
      expect(exchanged.statusCode).toBe(200);

      const row = await accessRow(person.id);
      expect(row).toMatchObject({ user_id: null, first_entered_at: null });
      expect(row.last_entered_at).not.toBeNull();
      const member = (await listed(cookies.admin!)).find((item) => item.accessId === person.id);
      expect(member).toMatchObject({ entered: false, name: null, lastEnteredAt: row.last_entered_at.toISOString() });

      // `entered` still gates the resend: the person has not entered with the account, so the welcome can be sent again.
      const resent = await call('POST', `${membersUrl(agencyA, clientA1)}/${person.id}/resend`, cookies.admin!);
      expect(resent.statusCode).toBe(200);
      expect(resent.json()).toMatchObject({ accessId: person.id, entered: false, name: null, lastEnteredAt: row.last_entered_at.toISOString() });
      await app.emailService.drain();
      expect(sender.sent.filter((message) => message.to === person.email && message.template === 'client-portal-welcome')).toHaveLength(1);
    });

    it('is still refused the resend once it entered with the account (first_entered_at), whatever the link recorded', async () => {
      const entered = await owner.knex('client_portal_accesses').where({ client_id: clientA1, user_id: users.portal!.id }).first();
      expect(entered.first_entered_at).not.toBeNull();
      const token = await issueApprovalLink(entered.id as string, clientA1);
      expect((await call('POST', '/portal-approval/session', undefined, { token }, '198.51.100.78')).statusCode).toBe(200);
      expect((await accessRow(entered.id as string)).first_entered_at.getTime()).toBe(entered.first_entered_at.getTime());

      const refused = await call('POST', `${membersUrl(agencyA, clientA1)}/${entered.id}/resend`, cookies.admin!);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('ACCESS_NOT_PENDING');
    });
  });
});
