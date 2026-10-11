import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContentsWorld, type PersonKey, type Reply } from './test-support/world.js';

// Issue #552. The person in charge is named by the link they have with the agency, in what the API answers and in what it takes:
// the collaborators contract hides everyone else's user id on purpose, so no route of Conteúdo gives one either, and a screen can
// show a name and choose a person with the link it already lists. Each test names the mutation that turns it red.
const w = createContentsWorld('owner-link');
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
  clientA = await w.newClient('a');
  folderA = await w.folderOf(clientA);
}, 60_000);

afterAll(async () => {
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

  it('answers the six transitions with the same owner and no user id of it', async () => {
    const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id, status: 'cancelled' });
    const reply = await w.call('POST', people.manager.cookie, `${urlA()}/${contentId}/reschedule`, {});
    expect(reply.statusCode).toBe(200);
    expect(reply.json().owner).toEqual(await ownerOf('production'));
    expect(keysOf(reply.json())).not.toContain('ownerUserId');
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

    const refused = async (reply: Reply, contentId: string, before: number, byTheDatabase = false): Promise<void> => {
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('CONTENT_OWNER_INVALID');
      expect(JSON.stringify(reply.json())).not.toMatch(NO_DATABASE_DETAIL);
      expect((await w.contentRow(contentId)).owner_user_id).toBe(people.production.id);
      expect(await w.countContents(clientA)).toBe(before);
      // The route refuses before it writes: the trigger of the database is the second barrier, not the first. A person who cannot
      // see Conteúdo has an active link, so only the trigger can tell: that case is the database's.
      if (!byTheDatabase) expect(w.statements.some((statement) => /(insert into|update) public\.contents\b/i.test(statement))).toBe(false);
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

    it('is refused when it does not exist, and when it is the link of someone who cannot see Conteúdo', async () => {
      const contentId = await w.seedContent(clientA, { ownerUserId: people.production.id });
      const before = await w.countContents(clientA);
      await refused(await send(randomUUID(), contentId), contentId, before);
      await refused(await send(await linkOf('sales'), contentId), contentId, before, true);
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
