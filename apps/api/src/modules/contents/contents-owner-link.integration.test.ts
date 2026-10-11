import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTransitionFixtures } from './test-support/transition-fixtures.js';
import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';
import type { TransitionAction } from './transition-errors.js';

// Issue #552. The person in charge is named by the link they have with the agency, in what the API answers and in what it takes:
// the collaborators contract hides everyone else's user id on purpose, so no route of Conteúdo gives one either, and a screen can
// show a name and choose a person with the link it already lists. Each test names the mutation that turns it red.
const w = createContentsWorld('owner-link');
const f = createTransitionFixtures(w);
const { people } = w;

const NO_DATABASE_DETAIL = /A00\d\d|deadlock|40P01|42501|pg_|relation|process|constraint/i;

let clientA: string;
let folderA: string;

const urlA = (clientId = clientA): string => `/agencies/${w.agencyA}/clients/${clientId}/contents`;
const create = { title: 'Lançamento da coleção', format: 'reels', publishOn: '2026-10-20' };

const linkOf = async (person: PersonKey, agencyId = w.agencyA): Promise<string> => {
  const row = await w.getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: people[person].id }).first('id');
  if (row === undefined) throw new Error(`${person} has no link with the agency.`);
  return row.id as string;
};
const ownerOf = async (person: PersonKey): Promise<{ membershipId: string; name: string }> => ({ membershipId: await linkOf(person), name: `Pessoa ${person}` });

const patch = (cookie: string, contentId: string, payload: Record<string, unknown>, clientId = clientA): Promise<Reply> =>
  w.call('PATCH', cookie, `${urlA(clientId)}/${contentId}`, payload);

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
};

/** Takes the link of a person out of service and puts it back, because the other tests of the file use them. */
const withRemovedLink = async (person: PersonKey, run: () => Promise<void>): Promise<void> => {
  await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: people[person].id }).update({ status: 'removed' });
  try {
    await run();
  } finally {
    await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: people[person].id }).update({ status: 'active' });
  }
};

beforeAll(async () => {
  await w.setup();
  await f.setup();
  clientA = await w.newClient('a');
  folderA = await w.folderOf(clientA);
}, 60_000);

afterAll(async () => {
  await f.cleanup();
  await w.teardown();
}, 60_000);

describe('what the API answers (issue #552)', () => {
  it('answers the list and the detail with owner { membershipId, name }, and no user id of the person in charge', async () => {
    const clientId = await w.newClient('owner-shape');
    const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id, publishOn: '2026-10-12', status: 'approved' });
    const expected = await ownerOf('production');

    const list = await w.call('GET', people.reader.cookie, `${urlA(clientId)}?from=2026-10-12&to=2026-10-12`);
    const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);

    expect(list.json().data.contents[0].owner).toEqual(expected);
    expect(detail.json().owner).toEqual(expected);
    for (const reply of [list, detail]) {
      expect(keysOf(reply.json())).not.toContain('ownerUserId');
      expect(JSON.stringify(reply.json())).not.toContain(people.production.id);
    }
  });

  it('names the person from the account of the link, read when asked', async () => {
    const clientId = await w.newClient('owner-name');
    const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id });
    await w.getOwner().knex.raw('update auth."user" set name = ? where id = ?', ['Nome Novo da Produção', people.production.id]);
    try {
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().owner).toEqual({ membershipId: await linkOf('production'), name: 'Nome Novo da Produção' });
    } finally {
      await w.getOwner().knex.raw('update auth."user" set name = ? where id = ?', ['Pessoa production', people.production.id]);
    }
  });

  it('still names a person whose link was removed, because the content was theirs', async () => {
    const clientId = await w.newClient('owner-removed');
    const contentId = await w.seedContent(clientId, { ownerUserId: people.manager.id, publishOn: '2026-10-13' });
    const expected = await ownerOf('manager');
    await withRemovedLink('manager', async () => {
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      const list = await w.call('GET', people.reader.cookie, `${urlA(clientId)}?from=2026-10-13&to=2026-10-13`);
      expect(detail.json().owner).toEqual(expected);
      expect(list.json().data.contents[0].owner).toEqual(expected);
    });
  });

  it('names a person of two agencies by the link they have with the agency of the client, once', async () => {
    const clientId = await w.newClient('owner-two-agencies');
    const contentId = await w.seedContent(clientId, { ownerUserId: people.dual.id, publishOn: '2026-10-14' });
    const expected = await ownerOf('dual');

    // Read by the person of both agencies, who can see the two links: only the agency of the client picks the right one.
    const list = await w.call('GET', people.dual.cookie, `${urlA(clientId)}?from=2026-10-14&to=2026-10-14`);
    const detail = await w.call('GET', people.dual.cookie, `${urlA(clientId)}/${contentId}`);

    expect(list.json().data.contents).toHaveLength(1);
    expect(list.json().data.contents[0].owner).toEqual(expected);
    expect(detail.json().owner).toEqual(expected);
  });

  it('answers owner null for an Owner who holds the agency by ownership alone, and still never a user id', async () => {
    const created = await w.call('POST', people.owner.cookie, urlA(), { ...create, folderId: folderA });
    expect(created.statusCode).toBe(201);
    expect(created.json().owner).toBeNull();
    expect(keysOf(created.json())).not.toContain('ownerUserId');
    expect((await w.contentRow(created.json().id)).owner_user_id).toBe(people.owner.id);
  });

  it('answers the reschedule with the same owner and no user id of it', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id, status: 'cancelled' });
    const reply = await w.call('POST', people.manager.cookie, `${urlA()}/${contentId}/reschedule`, {});
    expect(reply.statusCode).toBe(200);
    expect(reply.json().owner).toEqual(await ownerOf('production'));
    expect(keysOf(reply.json())).not.toContain('ownerUserId');
  });

  describe('no response of Conteúdo carries the user id of anyone (issue #552)', () => {
    const EVERY_USER_ID = (): string[] => f.allUserIds();

    /** The whole body, keys and values: a key that names a user id, or any user id of the world, anywhere in it, is a leak. */
    const leaks = (reply: Reply): string[] => {
      const text = JSON.stringify(reply.json());
      const keys = keysOf(reply.json()).filter((key) => /user_?id/i.test(key));
      return [...keys, ...EVERY_USER_ID().filter((id) => text.includes(id))];
    };

    /** A content approved by the person and the reason given, written the way the database writes it (an INSERT, which the guard lets through). */
    const seedApprovedBy = async (clientId: string, approvedBy: string, reason: string | null, ownerUserId = people.production.id): Promise<string> => {
      const id = randomUUID();
      await w.getOwner().knex('contents').insert({
        id,
        client_id: clientId,
        title: `Aprovado ${id.slice(0, 8)}`,
        platform: 'instagram',
        format: 'reels',
        publish_on: '2026-10-20',
        folder_id: await w.folderOf(clientId),
        owner_user_id: ownerUserId,
        status: 'approved',
        approved_by: approvedBy,
        approved_at: new Date('2026-10-05T12:00:00.000Z'),
        approved_by_agency_reason: reason
      });
      return id;
    };

    it('leaks nothing in the list, in the detail and in each of the six transitions, with owner, approver and subtasks that name people', async () => {
      const clientId = await w.newClient('no-user-id');
      const withTask = async (action: TransitionAction): Promise<{ contentId: string; body?: Record<string, unknown> }> => {
        const fixture = await f.fixtureFor(action, clientId);
        // The database takes no subtask into a published or a cancelled content, so those two answer an empty list.
        if (action !== 'unpublish' && action !== 'reschedule') await w.seedTask(fixture.contentId, 'approved');
        return fixture;
      };
      const read = await withTask('cancel');
      const list = await w.call('GET', people.reader.cookie, `${urlA(clientId)}?from=2026-10-01&to=2026-10-31`);
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${read.contentId}`);
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().tasks).toHaveLength(1);
      expect(leaks(list)).toEqual([]);
      expect(leaks(detail)).toEqual([]);

      for (const action of ['submit', 'approve-by-agency', 'publish', 'unpublish', 'cancel', 'reschedule'] as const) {
        const fixture = await withTask(action);
        const reply = await w.call('POST', people.admin.cookie, f.urlOf(clientId, fixture.contentId, action), fixture.body);
        expect(reply.statusCode, `${action} answered ${reply.statusCode}`).toBe(200);
        expect(reply.json().tasks, `${action} brings its subtasks`).toHaveLength(action === 'unpublish' || action === 'reschedule' ? 0 : 1);
        expect(leaks(reply), action).toEqual([]);
      }
    });

    it('leaks no id of the portal people nor of the fixture people, when they are the approver, the owner or the person of a subtask (issue #566)', async () => {
      const clientId = await w.newClient('no-user-id-everyone');
      const portalPerson = await f.portalMember(clientId);
      const fixturePerson = f.people.operateRead;
      const contentId = await seedApprovedBy(clientId, portalPerson, null, fixturePerson.id);
      const taskId = await w.seedTask(contentId, 'pending');
      await w.getOwner().knex('content_tasks').where({ id: taskId }).update({ assignee_user_id: fixturePerson.id });

      const list = await w.call('GET', people.reader.cookie, `${urlA(clientId)}?from=2026-10-20&to=2026-10-20`);
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);

      expect(detail.json().tasks).toHaveLength(1);
      expect(list.json().data.contents).toHaveLength(1);
      expect(EVERY_USER_ID()).toEqual(expect.arrayContaining([portalPerson, fixturePerson.id]));
      expect(leaks(list)).toEqual([]);
      expect(leaks(detail)).toEqual([]);
    });

    it('names who approved without an id: the name and the side, by the link of that side', async () => {
      const clientId = await w.newClient('approver');
      const portalPerson = await f.portalMember(clientId);
      const portalName = (await w.getOwner().knex('auth.user').where({ id: portalPerson }).first('name')).name as string;
      const approverOf = async (contentId: string): Promise<unknown> =>
        (await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`)).json().approvedBy;

      expect(await approverOf(await seedApprovedBy(clientId, portalPerson, null))).toEqual({ name: portalName, side: 'client' });
      expect(await approverOf(await seedApprovedBy(clientId, people.admin.id, 'Aprovado por telefone'))).toEqual({ name: 'Pessoa admin', side: 'agency' });
      expect(await approverOf(await seedApprovedBy(clientId, people.owner.id, 'Aprovado por telefone'))).toEqual({ name: 'Pessoa owner', side: 'agency' });
    });

    it('does not name a person who is tied to the side they approved from by nothing', async () => {
      const clientId = await w.newClient('approver-untied');
      const outsider = await seedApprovedBy(clientId, people.adminB.id, 'Aprovado por telefone');
      const portalSide = await seedApprovedBy(clientId, people.admin.id, null);

      const agency = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${outsider}`);
      const portal = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${portalSide}`);

      expect(agency.json().approvedBy).toEqual({ name: '', side: 'agency' });
      expect(portal.json().approvedBy).toEqual({ name: '', side: 'client' });
      expect(JSON.stringify([agency.json(), portal.json()])).not.toMatch(/Pessoa adminB|Pessoa admin"/);
    });

    it('names a person of the portal only by a link with the client of the content, not by the link they have with another client', async () => {
      const clientId = await w.newClient('approver-other-client');
      const otherClient = await w.newClient('approver-other-client-b');
      const portalPerson = await f.portalMember(otherClient);
      const contentId = await seedApprovedBy(clientId, portalPerson, null);
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().approvedBy).toEqual({ name: '', side: 'client' });
    });

    it('names the approver of a subtask only when they are tied to the agency', async () => {
      const clientId = await w.newClient('task-approver-untied');
      const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id });
      const task = await w.seedTask(contentId, 'approved');
      await w.getOwner().knex.raw('alter table public.content_tasks disable trigger content_tasks_guard');
      try {
        await w.getOwner().knex('content_tasks').where({ id: task }).update({ approved_by: people.adminB.id });
      } finally {
        await w.getOwner().knex.raw('alter table public.content_tasks enable trigger content_tasks_guard');
      }
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().tasks[0].approvedBy).toEqual({ name: '', side: 'agency' });
    });

    it('names the person of a subtask once, by the link of this agency, when they have a link with two', async () => {
      const clientId = await w.newClient('task-two-agencies');
      const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id });
      const task = await w.seedTask(contentId, 'pending');
      await w.getOwner().knex('content_tasks').where({ id: task }).update({ assignee_user_id: people.dual.id });
      // Read by the person of both agencies, who can see the two links: only the agency of the client picks the right one.
      const detail = await w.call('GET', people.dual.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().tasks).toHaveLength(1);
      expect(detail.json().tasks[0].assignee).toEqual(await ownerOf('dual'));
    });

    it('names the person a subtask is for by their link, and who approved it, without ids', async () => {
      const clientId = await w.newClient('task-people');
      const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id });
      const task = await w.seedTask(contentId, 'approved');
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().tasks.find((item: { id: string }) => item.id === task)).toMatchObject({
        assignee: await ownerOf('production'),
        approvedBy: { name: 'Pessoa admin', side: 'agency' }
      });
    });

    it('answers assignee null for a subtask of an Owner who holds the agency by ownership alone', async () => {
      const clientId = await w.newClient('task-owner');
      const contentId = await w.seedContent(clientId, { ownerUserId: people.production.id });
      const task = await w.seedTask(contentId, 'pending');
      await w.getOwner().knex('content_tasks').where({ id: task }).update({ assignee_user_id: people.owner.id });
      const detail = await w.call('GET', people.reader.cookie, `${urlA(clientId)}/${contentId}`);
      expect(detail.json().tasks[0].assignee).toBeNull();
    });
  });
});

describe('what the body takes (issue #552)', () => {
  it.each([
    ['create', 'POST'],
    ['edit', 'PATCH']
  ] as const)('refuses a user id on %s: the field does not exist any more, and nothing is written', async (_label, method) => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
    const before = await w.countContents(clientA);
    const body = { ownerUserId: people.manager.id };

    const reply = method === 'POST'
      ? await w.call('POST', people.admin.cookie, urlA(), { ...create, folderId: folderA, ...body })
      : await patch(people.admin.cookie, contentId, body);

    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
    expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
    expect(await w.countContents(clientA)).toBe(before);
  });

  it('answers 400 VALIDATION_ERROR to a link that is not an id', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
    const reply = await patch(people.admin.cookie, contentId, { ownerMembershipId: 'not-an-id' });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('chooses the person by link on create and on edit, and the column holds the user the link names', async () => {
    const created = await w.call('POST', people.production.cookie, urlA(), { ...create, folderId: folderA, ownerMembershipId: await linkOf('admin') });
    expect(created.statusCode).toBe(201);
    expect(created.json().owner).toEqual(await ownerOf('admin'));
    expect((await w.contentRow(created.json().id)).owner_user_id).toBe(people.admin.id);

    const edited = await patch(people.manager.cookie, created.json().id, { ownerMembershipId: await linkOf('production') });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().owner).toEqual(await ownerOf('production'));
    expect((await w.contentRow(created.json().id)).owner_user_id).toBe(people.production.id);
  });

  describe.each([
    ['create', 'POST'],
    ['edit', 'PATCH']
  ] as const)('on %s, a link that is not an active one of a collaborator of this agency', (_name, method) => {
    const send = (ownerMembershipId: string, contentId: string, cookie = people.admin.cookie): Promise<Reply> => {
      w.statements.length = 0;
      return method === 'POST'
        ? w.call('POST', cookie, urlA(), { ...create, folderId: folderA, ownerMembershipId })
        : patch(cookie, contentId, { ownerMembershipId });
    };

    const refused = async (reply: Reply, contentId: string, before: number): Promise<void> => {
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('CONTENT_OWNER_INVALID');
      expect(JSON.stringify(reply.json().error)).not.toMatch(NO_DATABASE_DETAIL);
      expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
      expect(await w.countContents(clientA)).toBe(before);
      // The route refuses before it writes: the trigger of the database is the second barrier, not the first.
      expect(w.statements.some((statement) => /(insert into|update) public\.contents\b/i.test(statement))).toBe(false);
    };

    it('is refused with 400 CONTENT_OWNER_INVALID when it belongs to another agency', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      await refused(await send(await linkOf('adminB', w.agencyB), contentId), contentId, before);
    });

    it('is refused when it belongs to another agency even though its person is also a collaborator of this one', async () => {
      // The person of two agencies could be a valid owner here, so only the agency of the link tells the two links apart.
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      // Asked by the person of both agencies, who can read the link of the other one: only the agency of the link refuses it.
      await refused(await send(await linkOf('dual', w.agencyB), contentId, people.dual.cookie), contentId, before);
    });

    it('is refused when it was removed', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      await withRemovedLink('manager', async () => {
        await refused(await send(await linkOf('manager'), contentId), contentId, before);
      });
    });

    it('is refused when it is a link of the portal of a client', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      const [portal] = await w.getOwner().knex('client_memberships').insert({ client_id: clientA, user_id: people.finance.id }).returning('id');
      try {
        await refused(await send(portal.id as string, contentId), contentId, before);
      } finally {
        await w.getOwner().knex('client_memberships').where({ id: portal.id }).delete();
      }
    });

    it('is refused when it does not exist', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      await refused(await send(randomUUID(), contentId), contentId, before);
    });

    it.each(['sales', 'finance', 'operateOnly', 'noContent'] as const)('is refused before any write when it is the link of %s, who cannot see Conteúdo (issue #566)', async (person) => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      await refused(await send(await linkOf(person), contentId), contentId, before);
    });
  });

  describe('the route and the database agree on who can see Conteúdo (issue #566)', () => {
    // `agency_user_can` is what the trigger A0073 asks and `ageniza_app` cannot call it: the route reads the same rule from the tables,
    // and this matrix ties the two. A route that refused a person the database accepts would block a valid owner; one that accepted
    // a person the database refuses would only be caught by the trigger, after a write.
    const knownToTheDatabase = async (person: PersonKey): Promise<boolean> => {
      const link = await w.getOwner().knex('agency_memberships').where({ agency_id: w.agencyA, user_id: people[person].id, status: 'active' }).first('id');
      if (link === undefined) return false;
      const result = await w.getOwner().knex.raw<{ rows: Array<{ can: boolean }> }>(
        "select app_private.agency_user_can(?::uuid, ?::uuid, 'conteudo.visualizar') as can", [w.agencyA, people[person].id]
      );
      return result.rows[0]?.can === true;
    };

    const asked = async (person: PersonKey): Promise<number> => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      return (await patch(people.admin.cookie, contentId, { ownerMembershipId: await linkOf(person) })).statusCode;
    };

    it('answers 200 to exactly the people the database accepts, and 400 to the others', async () => {
      const answers: Record<string, { database: boolean; route: number }> = {};
      for (const person of ['admin', 'manager', 'production', 'sales', 'finance', 'reader', 'operateOnly', 'noContent', 'approver', 'dual'] as const) {
        answers[person] = { database: await knownToTheDatabase(person), route: await asked(person) };
      }
      for (const [person, answer] of Object.entries(answers)) expect({ person, route: answer.route }, person).toEqual({ person, route: answer.database ? 200 : 400 });
      expect(Object.values(answers).filter((answer) => answer.database).length).toBeGreaterThan(3);
      expect(Object.values(answers).filter((answer) => !answer.database).length).toBeGreaterThan(3);
    });

    it('refuses a link whose role belongs to another agency, even when that role can see Conteúdo, as the database does', async () => {
      const foreignRole = await w.customRole(w.agencyB, ['conteudo.visualizar']);
      const [link] = await w.getOwner().knex('agency_memberships').insert({ agency_id: w.agencyA, user_id: people.adminB.id, role_id: foreignRole }).returning('id');
      try {
        expect(await knownToTheDatabase('adminB')).toBe(false);
        const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
        w.statements.length = 0;
        // Asked by the person of both agencies, whose RLS reads the role of the other one: only the scope of the role refuses it.
        const reply = await patch(people.dual.cookie, contentId, { ownerMembershipId: link.id as string });
        expect(reply.statusCode).toBe(400);
        expect(reply.json().error.code).toBe('CONTENT_OWNER_INVALID');
        expect(w.statements.some((statement) => /update public\.contents\b/i.test(statement))).toBe(false);
      } finally {
        await w.getOwner().knex('agency_memberships').where({ id: link.id }).delete();
      }
    });

    it('accepts the Owner of the agency by a link whose role cannot see Conteúdo, as the database does', async () => {
      const roleId = await w.customRole(w.agencyA, ['cliente.visualizar']);
      const [link] = await w.getOwner().knex('agency_memberships').insert({ agency_id: w.agencyA, user_id: people.owner.id, role_id: roleId }).returning('id');
      try {
        expect(await knownToTheDatabase('owner')).toBe(true);
        const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
        const reply = await patch(people.admin.cookie, contentId, { ownerMembershipId: link.id as string });
        expect(reply.statusCode).toBe(200);
        expect((await w.contentRow(contentId)).owner_user_id).toBe(people.owner.id);
      } finally {
        await w.getOwner().knex('agency_memberships').where({ id: link.id }).delete();
      }
    });
  });

  it('answers 403 to who may not change the person in charge, whatever the link is: the answer never says whether a link is an active one', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
    const links = [await linkOf('manager'), await linkOf('adminB', w.agencyB), randomUUID()];
    for (const ownerMembershipId of links) {
      const reply = await patch(people.production.cookie, contentId, { ownerMembershipId });
      expect(reply.statusCode).toBe(403);
      expect(reply.json().error.code).toBe('FORBIDDEN');
    }
    expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
  });

  it('answers 409 CLIENT_ARCHIVED before looking at the link, and writes nothing', async () => {
    const archived = await w.newClient('owner-archived', { status: 'archived' });
    const contentId = await w.seedContent(archived, { ownerUserId: people.production.id });
    const reply = await patch(people.admin.cookie, contentId, { ownerMembershipId: randomUUID() }, archived);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('CLIENT_ARCHIVED');
    expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
  });
});
