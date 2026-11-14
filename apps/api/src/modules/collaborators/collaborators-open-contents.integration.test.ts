import { randomUUID } from 'node:crypto';

import type { CollaboratorOpenContentsResponse } from '@ageniza/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertTestUser, TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createPortalFixtures } from '../contents/test-support/portal-fixtures.js';
import { createContentsWorld, type Reply, type SeedContent } from '../contents/test-support/world.js';

// Scope redesign-igual, subtask W8-S1 (decision 2026-11-11): the read behind "Clientes e o que está com ele" and the header of the
// collaborator's page. The matrix of who looks, the count per person, the agency that does not leak, the order of `now`, the one 404
// of a link that is not there, and the errors of the database. The last test takes the policy of `contents` away to prove the agency
// and the owner are in the query itself.
const w = createContentsWorld('opencontents');
const p = createPortalFixtures(w);
const { people } = w;

const knex = () => w.getOwner().knex;
const extraUserIds: string[] = [];
const roleKeys = { collabOnly: ['colaborador.visualizar'], both: ['colaborador.visualizar', 'conteudo.visualizar'] } as const;
const extra = {} as Record<keyof typeof roleKeys, { id: string; cookie: string }>;

let membership: Record<'production' | 'manager' | 'reader' | 'admin' | 'approver' | 'dual' | 'adminB', { a?: string; b?: string }>;
let clientX: string;
let clientY: string;
let clientZ: string;
let clientB: string;
let removedMembershipId: string;

type Body = CollaboratorOpenContentsResponse;
const url = (membershipId: string, agencyId = w.agencyA): string => `/agencies/${agencyId}/collaborators/${membershipId}/open-contents`;
const read = (cookie: string, membershipId: string, agencyId = w.agencyA): Promise<Reply> => w.call('GET', cookie, url(membershipId, agencyId));
const bodyOf = (reply: Reply): Body => {
  expect(reply.statusCode).toBe(200);
  return reply.json<Body>();
};
const idOf = async (agencyId: string, userId: string): Promise<string> =>
  (await knex()('agency_memberships').where({ agency_id: agencyId, user_id: userId }).first('id'))!.id as string;
const clientNames = (body: Body): string[] => body.data.map((entry) => entry.client.name);
const contentIds = (entry: Body['data'][number]): string[] => entry.now.map((content) => content.contentId);
const refusal = (reply: Reply): { status: number; error: { code: string; message: string } } =>
  ({ status: reply.statusCode, error: reply.json().error });

const seed = (clientId: string, owner: string, status: NonNullable<SeedContent['status']>, publishOn = '2026-10-20', publishAtTime: string | null = '10:00'): Promise<string> =>
  w.seedContent(clientId, { status, ownerUserId: owner, publishOn, publishAtTime, ...(status === 'approved' ? { approval: { by: people.admin.id } } : {}) });

beforeAll(async () => {
  await w.setup();
  await p.setup();

  for (const key of Object.keys(roleKeys) as Array<keyof typeof roleKeys>) {
    const user = await insertTestUser(w.getApp().pool, w.getApp().auth, { emailLabel: `opencontents-${key.toLowerCase()}`, name: `Extra ${key}` });
    extraUserIds.push(user.id);
    await knex()('agency_memberships').insert({ agency_id: w.agencyA, user_id: user.id, role_id: await w.customRole(w.agencyA, roleKeys[key]) });
    const login = await w.getApp().app.inject({ method: 'POST', url: '/auth/login', headers: { origin: TEST_APP_PUBLIC_URL }, payload: { email: user.email, password: user.password } });
    expect(login.statusCode).toBe(200);
    extra[key] = { id: user.id, cookie: login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') };
  }
  // The owner of agency B, who is a stranger to agency A.
  await knex()('agencies').where({ id: w.agencyB }).update({ owner_user_id: people.adminB.id });

  clientX = await w.newClient('a-x');
  clientY = await w.newClient('b-y');
  clientZ = await w.newClient('c-z');
  clientB = await w.newClient('b-agency', { agencyId: w.agencyB });

  membership = {
    production: { a: await idOf(w.agencyA, people.production.id) },
    manager: { a: await idOf(w.agencyA, people.manager.id) },
    reader: { a: await idOf(w.agencyA, people.reader.id) },
    admin: { a: await idOf(w.agencyA, people.admin.id) },
    approver: { a: await idOf(w.agencyA, people.approver.id) },
    dual: { a: await idOf(w.agencyA, people.dual.id), b: await idOf(w.agencyB, people.dual.id) },
    adminB: { b: await idOf(w.agencyB, people.adminB.id) }
  };
});

afterAll(async () => {
  await knex()('contents').whereIn('owner_user_id', extraUserIds).delete();
  await p.cleanup();
  await knex()('agency_memberships').whereIn('user_id', extraUserIds).delete();
  await w.getApp().pool.query('delete from auth."user" where id = any($1::uuid[])', [extraUserIds]);
  await w.teardown();
});

describe('the count per person', () => {
  beforeAll(async () => {
    const production = people.production.id;
    const manager = people.manager.id;
    // The production person: four open in X (one waiting), two waiting in Y, and three that are not open.
    await seed(clientX, production, 'in_production', '2026-10-20');
    await seed(clientX, production, 'awaiting_approval', '2026-10-18');
    await seed(clientX, production, 'adjusting', '2026-10-25');
    await seed(clientX, production, 'approved', '2026-10-22');
    await seed(clientX, production, 'published');
    await seed(clientX, production, 'cancelled');
    await seed(clientY, production, 'awaiting_approval', '2026-10-19');
    await seed(clientY, production, 'awaiting_approval', '2026-10-21');
    await seed(clientY, production, 'published');
    // Somebody else's, in the same clients: it must not reach the production person's count.
    await seed(clientX, manager, 'in_production');
    await seed(clientZ, manager, 'awaiting_approval');
  });

  it('counts only the contents the person owns, only the open ones, and the waiting ones apart; the summary is the sum of the data', async () => {
    const body = bodyOf(await read(people.admin.cookie, membership.production.a!));

    expect(body.summary).toEqual({ clients: 2, contents: 6, awaiting: 3 });
    expect(body.data.map((entry) => [entry.contents, entry.awaiting, entry.now.length])).toEqual([[4, 1, 3], [2, 2, 2]]);
    expect(body.data.map((entry) => entry.client.id)).toEqual([clientX, clientY]);
    expect(body.summary).toEqual({
      clients: body.data.length,
      contents: body.data.reduce((sum, entry) => sum + entry.contents, 0),
      awaiting: body.data.reduce((sum, entry) => sum + entry.awaiting, 0)
    });
    expect(Object.keys(body.data[0]!.now[0]!).sort()).toEqual(['contentId', 'state', 'title']);
  });

  it('names the state of each content with the state of the module, and never lists one that is published, cancelled or somebody else\'s', async () => {
    const body = bodyOf(await read(people.admin.cookie, membership.production.a!));
    const states = body.data.flatMap((entry) => entry.now.map((content) => content.state));

    // X holds four open ones and shows the three nearest: the adjusting one, the farthest, is counted and left out of `now`.
    expect(states.sort()).toEqual(['approved', 'awaiting_approval', 'awaiting_approval', 'awaiting_approval', 'in_production']);
    const rows = await knex()('contents').whereIn('id', body.data.flatMap(contentIds)).select('owner_user_id', 'status', 'title');
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.owner_user_id === people.production.id && !['published', 'cancelled'].includes(row.status as string))).toBe(true);
  });

  it('gives each person their own: the manager has one in X and one waiting in Z, and the production person has none of Z', async () => {
    const manager = bodyOf(await read(people.admin.cookie, membership.manager.a!));
    expect(manager.summary).toEqual({ clients: 2, contents: 2, awaiting: 1 });
    expect(manager.data.map((entry) => [entry.client.id, entry.contents, entry.awaiting])).toEqual([[clientX, 1, 0], [clientZ, 1, 1]]);
  });

  it('answers 200 with a zeroed summary and no clients for a person who owns nothing open', async () => {
    const reply = await read(people.admin.cookie, membership.approver.a!);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ summary: { clients: 0, contents: 0, awaiting: 0 }, data: [] });
  });

  it('a person who holds both permissions, and the Owner, read another person\'s cards and get the same body an Admin gets', async () => {
    const asAdmin = bodyOf(await read(people.admin.cookie, membership.production.a!));
    expect(bodyOf(await read(extra.both.cookie, membership.production.a!))).toEqual(asAdmin);
    expect(bodyOf(await read(people.owner.cookie, membership.production.a!))).toEqual(asAdmin);
  });

  it('a person with only colaborador.visualizar is refused on their own link too: reading one\'s own cards takes conteudo.visualizar as well', async () => {
    const ownId = await idOf(w.agencyA, extra.collabOnly.id);
    expect(refusal(await read(extra.collabOnly.cookie, ownId)).status).toBe(403);
    expect((await read(extra.collabOnly.cookie, ownId)).json().error.code).toBe('FORBIDDEN');
  });

  it('a person who holds both permissions reads their own link', async () => {
    const ownId = await idOf(w.agencyA, extra.both.id);
    expect(bodyOf(await read(extra.both.cookie, ownId))).toEqual({ summary: { clients: 0, contents: 0, awaiting: 0 }, data: [] });
  });
});

describe('who looks', () => {
  const target = (): string => membership.production.a!;

  it('401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: url(target()), headers: { origin: TEST_APP_PUBLIC_URL } });
    expect(reply.statusCode).toBe(401);
  });

  it.each([
    ['the Owner, by ownership, gets 200', () => people.owner.cookie, 200],
    ['an Admin gets 200', () => people.admin.cookie, 200],
    ['a role with colaborador.visualizar and conteudo.visualizar gets 200', () => extra.both.cookie, 200],
    ['an Admin who also has a link to a client of the portal gets 200', () => p.people.dualAdmin.cookie, 200],
    ['a role with only colaborador.visualizar gets 403', () => extra.collabOnly.cookie, 403],
    ['a role with only conteudo.visualizar gets 403', () => people.reader.cookie, 403],
    ['a role with neither key gets 403', () => people.noContent.cookie, 403],
    ['a collaborator with only conteudo.visualizar who is also a person of the portal gets 403', () => p.people.dualRead.cookie, 403]
  ] as const)('%s', async (_label, cookie, status) => {
    const reply = await read(cookie(), target());
    expect(reply.statusCode).toBe(status);
    if (status === 403) expect(reply.json().error.code).toBe('FORBIDDEN');
    else expect(reply.json().summary.contents).toBe(6);
  });

  it('404 for who has no link to the agency: a person of the portal, the Admin and Owner of another agency, and an Admin of another agency with a link to a client of this one', async () => {
    const cookies = [p.people.portalOne.cookie, p.people.portalMulti.cookie, people.adminB.cookie, p.people.crossDual.cookie];
    for (const cookie of cookies) {
      expect(refusal(await read(cookie, target()))).toEqual({ status: 404, error: { code: 'NOT_FOUND', message: 'Agency not found.' } });
    }
    expect(refusal(await read(people.admin.cookie, target(), randomUUID()))).toEqual({ status: 404, error: { code: 'NOT_FOUND', message: 'Agency not found.' } });
  });

  it('a person of both agencies is judged by the agency of the route', async () => {
    expect((await read(people.dual.cookie, target(), w.agencyA)).statusCode).toBe(200);
    expect((await read(people.dual.cookie, membership.adminB.b!, w.agencyB)).statusCode).toBe(200);
  });

  it('the order of the refusals is the detail\'s: the door (403) comes before the 404 of the link, and the 404 of the link before anything is read', async () => {
    for (const membershipId of [randomUUID(), 'not-a-uuid', membership.adminB.b!]) {
      expect((await read(extra.collabOnly.cookie, membershipId)).statusCode).toBe(403);
      expect((await read(people.reader.cookie, membershipId)).statusCode).toBe(403);
      expect((await read(people.admin.cookie, membershipId)).statusCode).toBe(404);
    }
  });

  it('answers 400 to an undeclared query parameter, like the detail', async () => {
    const reply = await w.call('GET', people.admin.cookie, `${url(target())}?status=all`);
    expect(reply.statusCode).toBe(400);
  });
});

describe('the one 404 of a link that is not there', () => {
  beforeAll(async () => {
    const removed = await insertTestUser(w.getApp().pool, w.getApp().auth, { emailLabel: 'opencontents-removed', name: 'Extra removed' });
    extraUserIds.push(removed.id);
    const role = (await knex()('roles').whereNull('agency_id').where({ key: 'production' }).first('id'))!.id as string;
    await knex()('agency_memberships').insert({ agency_id: w.agencyA, user_id: removed.id, role_id: role });
    await seed(clientX, removed.id, 'in_production');
    await knex()('agency_memberships').where({ agency_id: w.agencyA, user_id: removed.id }).update({ status: 'removed' });
    removedMembershipId = await idOf(w.agencyA, removed.id);
  });

  // `dual` is an Admin of both agencies, so `agency_memberships_select` shows him the links of B on the route of A: only the query keeps them out.
  it('is the same answer for a link of another agency, a nonexistent one, a malformed one and a removed one, to the Owner and to Admins alike', async () => {
    const ids = [membership.adminB.b!, membership.dual.b!, randomUUID(), 'not-a-uuid', removedMembershipId, removedMembershipId.toUpperCase().replace(/-/g, '')];
    const answers = new Set<string>();
    for (const cookie of [people.owner.cookie, people.admin.cookie, people.dual.cookie]) {
      for (const membershipId of ids) {
        const reply = await read(cookie, membershipId);
        expect(reply.statusCode).toBe(404);
        answers.add(JSON.stringify(reply.json().error));
      }
    }
    expect([...answers]).toEqual([JSON.stringify({ code: 'NOT_FOUND', message: 'Collaborator not found.' })]);
  });

  it('a removed person is not read even by someone who sees removed links', async () => {
    const reply = await read(people.owner.cookie, removedMembershipId);
    expect(reply.statusCode).toBe(404);
  });
});

describe('the agency of the route', () => {
  it('does not bring the contents the same person owns in another agency, where they also have a link', async () => {
    await seed(clientX, people.dual.id, 'in_production');
    await seed(clientB, people.dual.id, 'awaiting_approval');
    await seed(clientB, people.dual.id, 'approved');

    // The viewer is an Admin of both agencies too, so the policy shows him every one of these rows: only the query keeps the other agency out.
    const inA = bodyOf(await read(people.dual.cookie, membership.dual.a!));
    expect(inA.summary).toEqual({ clients: 1, contents: 1, awaiting: 0 });
    expect(inA.data.map((entry) => entry.client.id)).toEqual([clientX]);

    const inB = bodyOf(await read(people.dual.cookie, membership.dual.b!, w.agencyB));
    expect(inB.summary).toEqual({ clients: 1, contents: 2, awaiting: 1 });
    expect(inB.data.map((entry) => entry.client.id)).toEqual([clientB]);
    expect(bodyOf(await read(people.adminB.cookie, membership.dual.b!, w.agencyB))).toEqual(inB);
  });
});

describe('now', () => {
  let timed: string[];
  let nullTime: string;
  let timedV: string[];

  beforeAll(async () => {
    const reader = people.reader.id;
    const wClient = await w.newClient('d-w');
    const vClient = await w.newClient('e-v');
    // Five in W: the third day's contents tie on day and hour, and one has no hour (it comes after the ones with an hour that day).
    await seed(wClient, reader, 'in_production', '2026-11-02', '08:00');
    const tieA = await seed(wClient, reader, 'awaiting_approval', '2026-10-30', '09:00');
    const tieB = await seed(wClient, reader, 'adjusting', '2026-10-30', '09:00');
    nullTime = await seed(wClient, reader, 'approved', '2026-10-30', null);
    const first = await seed(wClient, reader, 'in_production', '2026-10-29', '23:00');
    timed = [first, ...[tieA, tieB].sort()];
    // Two in V, to see the hour against no hour.
    const vNull = await seed(vClient, reader, 'in_production', '2026-10-30', null);
    const vTimed = await seed(vClient, reader, 'in_production', '2026-10-30', '23:59');
    timedV = [vTimed, vNull];
  });

  it('brings at most three per client, the nearest to going live first, with the id as the tie-break, while the count says five', async () => {
    const body = bodyOf(await read(people.admin.cookie, membership.reader.a!));
    const entry = body.data.find((candidate) => candidate.client.name.includes('d-w'))!;

    expect(entry.contents).toBe(5);
    expect(entry.awaiting).toBe(1);
    expect(contentIds(entry)).toEqual(timed);
    expect(entry.now).toHaveLength(3);
    expect(contentIds(entry)).not.toContain(nullTime);
  });

  it('puts a content with an hour before one with none on the same day', async () => {
    const body = bodyOf(await read(people.admin.cookie, membership.reader.a!));
    expect(contentIds(body.data.find((candidate) => candidate.client.name.includes('e-v'))!)).toEqual(timedV);
  });

  it('orders the clients by name and counts each one once', async () => {
    const body = bodyOf(await read(people.admin.cookie, membership.reader.a!));
    expect(clientNames(body).map((name) => name.split(' ')[2])).toEqual(['d-w', 'e-v']);
    expect(body.summary).toEqual({ clients: 2, contents: 7, awaiting: 1 });
  });
});

describe('the order of the clients', () => {
  it('is by the folded name compared byte by byte, as the listing does: punctuation, accent and capitals do not reorder', async () => {
    const owner = extra.both.id;
    // Raw `client_name` would put "Zeta" first (capital) and "Éclair" last (multi-byte), or "ab" before "a-z" under a locale collation.
    const labels = ['Zeta', 'alfa', 'Éclair', 'ab', 'a-z'];
    const ids = new Map<string, string>();
    for (const label of labels) {
      const clientId = await w.newClient(label);
      ids.set(label, clientId);
      await seed(clientId, owner, 'in_production');
    }

    const body = bodyOf(await read(people.admin.cookie, await idOf(w.agencyA, owner)));

    expect(body.data.map((entry) => entry.client.id)).toEqual(['a-z', 'ab', 'alfa', 'Éclair', 'Zeta'].map((label) => ids.get(label)!));
  });
});

describe('the ceiling of 100 clients', () => {
  it('lists the first hundred by name and still counts all of them in the summary', async () => {
    const owner = people.admin.id;
    const names: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const clientId = await w.newClient(`cap-${String(index).padStart(3, '0')}`);
      names.push(clientId);
      await seed(clientId, owner, index % 2 === 0 ? 'awaiting_approval' : 'in_production');
    }

    const body = bodyOf(await read(people.admin.cookie, membership.admin.a!));

    expect(body.data).toHaveLength(100);
    expect(body.summary).toEqual({ clients: 101, contents: 101, awaiting: 51 });
    expect(body.data.map((entry) => entry.client.id)).toEqual(names.slice(0, 100));
  });
});

describe('the errors of the database', () => {
  const failing = (code: string): Error => Object.assign(new Error(`simulated ${code}`), { code });
  const failsOn = async (code: string, statement: RegExp): Promise<Reply> => {
    w.runBeforeStatement(statement, async () => { throw failing(code); });
    try {
      return await read(people.admin.cookie, membership.production.a!);
    } finally {
      w.clearHook();
    }
  };

  it.each([
    ['42501', 403, 'FORBIDDEN'],
    ['40P01', 409, 'TRY_AGAIN'],
    ['40001', 409, 'TRY_AGAIN'],
    ['XX000', 500, 'INTERNAL_ERROR']
  ] as const)('maps %s to %i %s, on the read of the link and on the read of the contents, and a later call works', async (errcode, status, code) => {
    for (const statement of [/select membership\.user_id\s+from public\.agency_memberships/, /with mine as/]) {
      const reply = await failsOn(errcode, statement);
      expect(refusal(reply).status).toBe(status);
      expect(reply.json().error.code).toBe(code);
    }
    expect((await read(people.admin.cookie, membership.production.a!)).statusCode).toBe(200);
  });
});

describe('the query itself, apart from the policy', () => {
  // The policies of `contents` and `clients` are made as permissive as they can be: whatever the route returns now, its own predicate decided it.
  const withPoliciesOpen = async (run: () => Promise<void>): Promise<void> => {
    const policies = [['contents', 'contents_select'], ['clients', 'clients_select']] as const;
    const saved = new Map<string, string>();
    for (const [table, name] of policies) {
      const found = (await knex().raw(`select qual from pg_policies where schemaname = 'public' and tablename = ? and policyname = ?`, [table, name])).rows[0]?.qual as string | undefined;
      expect(found).toBeDefined();
      saved.set(name, found!);
    }
    for (const [table, name] of policies) await knex().raw(`alter policy ${name} on public.${table} using (true)`);
    try {
      await run();
    } finally {
      for (const [table, name] of policies) await knex().raw(`alter policy ${name} on public.${table} using (${saved.get(name)!})`);
    }
  };

  it('still answers only the agency of the route and only the owner, though the policy would show the person every content of every agency', async () => {
    await withPoliciesOpen(async () => {
      const open = await knex().raw(`select count(*) as count from pg_policies where schemaname = 'public' and policyname in ('contents_select', 'clients_select') and qual = 'true'`);
      expect(Number(open.rows[0].count)).toBe(2);

      const dualInA = bodyOf(await read(people.admin.cookie, membership.dual.a!));
      expect(dualInA.summary).toEqual({ clients: 1, contents: 1, awaiting: 0 });
      expect(dualInA.data.map((entry) => entry.client.id)).toEqual([clientX]);
      const dualInB = bodyOf(await read(people.adminB.cookie, membership.dual.b!, w.agencyB));
      expect(dualInB.summary).toEqual({ clients: 1, contents: 2, awaiting: 1 });

      const production = bodyOf(await read(people.admin.cookie, membership.production.a!));
      expect(production.summary).toEqual({ clients: 2, contents: 6, awaiting: 3 });
      const manager = bodyOf(await read(people.admin.cookie, membership.manager.a!));
      expect(manager.summary).toEqual({ clients: 2, contents: 2, awaiting: 1 });
    });

    // The policies are back: the reader of another agency is still refused by the guard and the row filter of the policy is the original.
    const restored = await knex().raw(`select count(*) as count from pg_policies where schemaname = 'public' and policyname in ('contents_select', 'clients_select') and qual <> 'true'`);
    expect(Number(restored.rows[0].count)).toBe(2);
  });
});
