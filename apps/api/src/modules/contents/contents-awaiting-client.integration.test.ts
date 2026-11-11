import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Scope telas-melhorias, subtask S4: "Parado no cliente" of the agency's Início (decision 2026-11-10, "o Início da agência mostra o que
// está parado no cliente"). It lists what awaits the client under the permission and the policy that show the calendar, with the state of
// the deadline counted on the day of São Paulo. The instant is fixed by the clock the module is given, so a test that lives at 01:30Z
// (still the evening before in São Paulo) does not depend on the hour it runs at.
const w = createContentsWorld('awaiting');
const { people } = w;

const AT_0130Z = new Date('2026-11-10T01:30:00.000Z'); // 2026-11-09 22:30 in America/Sao_Paulo
let clock: Date | undefined;

const knex = () => w.getOwner().knex;
const awaitingUrl = (agencyId = w.agencyA): string => `/agencies/${agencyId}/contents/awaiting-client`;
const read = (cookie = people.reader.cookie, agencyId = w.agencyA): Promise<Reply> => w.call('GET', cookie, awaitingUrl(agencyId));

type Item = { id: string; title: string; sentAt: string | null; dueOn: string | null; daysWaiting: number | null; daysToDue: number | null };
type Group = { clientId: string; clientName: string; contents: Item[] };
const groupsOf = (reply: Reply): Group[] => reply.json().data;
const idsOf = (reply: Reply): string[] => groupsOf(reply).flatMap((group) => group.contents.map((item) => item.id));

/** A content awaiting approval, with the round the owner writes by hand so the instant it was sent is the one the test names. */
const seedWaiting = async (
  clientId: string,
  title: string,
  round?: { dueOn: string | null; sentAt: string; note?: string | null },
  ownerUserId = people.production.id
): Promise<string> => {
  const id = await w.seedContent(clientId, { status: 'awaiting_approval', title, ownerUserId });
  if (round !== undefined) {
    await knex()('content_approval_rounds').insert({
      batch_id: randomUUID(), client_id: clientId, content_id: id, sequence: 1,
      due_on: round.dueOn, note: round.note ?? null, sent_by: people.manager.id, sent_at: round.sentAt
    });
  }
  return id;
};

let clientX: string;
let clientY: string;
let clientB: string;
let ids: Record<string, string>;

beforeAll(async () => {
  await w.setup({ contentsClock: () => clock ?? new Date() });
  clientX = await w.newClient('x');
  clientY = await w.newClient('y');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
  clock = AT_0130Z;

  ids = {
    overdue: await seedWaiting(clientY, 'Venceu ontem', { dueOn: '2026-11-08', sentAt: '2026-11-05T12:00:00.000Z' }),
    today: await seedWaiting(clientY, 'Vence hoje', { dueOn: '2026-11-09', sentAt: '2026-11-06T12:00:00.000Z' }),
    tomorrow: await seedWaiting(clientX, 'Vence amanhã', { dueOn: '2026-11-10', sentAt: '2026-11-08T12:00:00.000Z', note: 'Preciso até amanhã.' }),
    later: await seedWaiting(clientX, 'Vence em três dias', { dueOn: '2026-11-12', sentAt: '2026-11-08T12:00:00.000Z' }),
    noDue: await seedWaiting(clientX, 'Sem prazo', { dueOn: null, sentAt: '2026-11-09T02:30:00.000Z' }),
    legacy: await seedWaiting(clientX, 'Antes das rodadas')
  };
  // None of these awaits the client, or none is asked of a client the agency can still ask: they never show.
  await w.seedContent(clientX, { status: 'in_production', title: 'Em produção' });
  await w.seedContent(clientX, { status: 'adjusting', title: 'Em ajuste' });
  await w.seedContent(clientX, { status: 'approved', title: 'Aprovado' });
  await w.seedContent(clientX, { status: 'published', title: 'Publicado' });
  await w.seedContent(clientX, { status: 'cancelled', title: 'Cancelado' });
  const archived = await w.newClient('archived');
  await seedWaiting(archived, 'De cliente arquivado', { dueOn: '2026-11-12', sentAt: '2026-11-08T12:00:00.000Z' });
  await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
  await seedWaiting(clientB, 'De outra agência', { dueOn: '2026-11-12', sentAt: '2026-11-08T12:00:00.000Z' }, people.adminB.id);
}, 90_000);

afterEach(() => {
  clock = AT_0130Z;
});

afterAll(async () => {
  await w.teardown();
}, 60_000);

describe('what is stuck with the client, on the day of São Paulo', () => {
  it('counts the days to the deadline from the São Paulo day, not the UTC one: 01:30Z is still the evening before', async () => {
    const reply = await read();

    expect(reply.statusCode).toBe(200);
    const byId = new Map(groupsOf(reply).flatMap((group) => group.contents).map((item) => [item.id, item]));
    expect(byId.get(ids.overdue!)).toMatchObject({ dueOn: '2026-11-08', daysToDue: -1 });
    expect(byId.get(ids.today!)).toMatchObject({ dueOn: '2026-11-09', daysToDue: 0 });
    expect(byId.get(ids.tomorrow!)).toMatchObject({ dueOn: '2026-11-10', daysToDue: 1 });
    expect(byId.get(ids.later!)).toMatchObject({ dueOn: '2026-11-12', daysToDue: 3 });
  });

  it('counts the days waiting from the day the round was sent in São Paulo, with or without a deadline', async () => {
    const byId = new Map(groupsOf(await read()).flatMap((group) => group.contents).map((item) => [item.id, item]));

    expect(byId.get(ids.noDue!)).toMatchObject({ sentAt: '2026-11-09T02:30:00.000Z', dueOn: null, daysWaiting: 1, daysToDue: null });
    expect(byId.get(ids.later!)).toMatchObject({ daysWaiting: 1 });
    expect(byId.get(ids.overdue!)).toMatchObject({ daysWaiting: 4 });
  });

  it('moves the counts when the clock moves, and the same instant gives the same answer', async () => {
    clock = new Date('2026-11-10T04:00:00.000Z'); // 01:00 of the 10th in São Paulo
    const byId = new Map(groupsOf(await read()).flatMap((group) => group.contents).map((item) => [item.id, item]));

    expect(byId.get(ids.tomorrow!)).toMatchObject({ daysToDue: 0, daysWaiting: 2 });
    expect(byId.get(ids.overdue!)).toMatchObject({ daysToDue: -2 });
  });

  it('never counts negative days waiting, even for a round sent after the instant asked about', async () => {
    clock = new Date('2026-11-01T15:00:00.000Z');
    const byId = new Map(groupsOf(await read()).flatMap((group) => group.contents).map((item) => [item.id, item]));

    expect(byId.get(ids.later!)?.daysWaiting).toBe(0);
  });

  it('gives a content that waited before the rounds existed no date and no counts, and still lists it', async () => {
    const byId = new Map(groupsOf(await read()).flatMap((group) => group.contents).map((item) => [item.id, item]));

    expect(byId.get(ids.legacy!)).toMatchObject({ title: 'Antes das rodadas', sentAt: null, dueOn: null, daysWaiting: null, daysToDue: null });
  });

  it('groups by client, the most urgent first: the earliest deadline, then who waits longest, then a content with no round', async () => {
    const groups = groupsOf(await read());

    expect(groups.map((group) => group.clientId)).toEqual([clientY, clientX]);
    expect(groups[0]!.clientName).toContain('Contents awaiting y');
    expect(groups[0]!.contents.map((item) => item.id)).toEqual([ids.overdue, ids.today]);
    expect(groups[1]!.contents.map((item) => item.id)).toEqual([ids.tomorrow, ids.later, ids.noDue, ids.legacy]);
    expect(Object.keys(groups[1]!.contents[0]!).sort()).toEqual(['daysToDue', 'daysWaiting', 'dueOn', 'format', 'id', 'publishOn', 'sentAt', 'title']);
  });

  it('lists only what awaits the client, of clients still active, of this agency', async () => {
    const titles = groupsOf(await read()).flatMap((group) => group.contents.map((item) => item.title));

    expect(titles.sort()).toEqual(['Antes das rodadas', 'Sem prazo', 'Venceu ontem', 'Vence amanhã', 'Vence em três dias', 'Vence hoje'].sort());
  });

  it('does not give the note, the batch or who sent it: this is a summary of the agency', async () => {
    const reply = await read();

    for (const secret of ['Preciso até amanhã.', people.manager.id, 'batch', 'sentBy', 'note']) expect(JSON.stringify(reply.json())).not.toContain(secret);
    expect(reply.json().meta).toEqual({ truncated: false });
  });
});

describe('who sees it', () => {
  it('lets a person who may read the contents see what the calendar shows them', async () => {
    for (const person of ['reader', 'admin', 'manager', 'production', 'owner'] as const) {
      const reply = await read(people[person].cookie);
      expect(reply.statusCode, person).toBe(200);
      expect(idsOf(reply).sort(), person).toEqual(Object.values(ids).sort());
    }
  });

  it.each(['noContent', 'operateOnly'] as const)('answers 403 to %s, who cannot read the contents, before any statement of the module', async (person) => {
    w.statements.length = 0;

    const reply = await read(people[person].cookie);

    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
    expect(w.mentionsContents()).toBe(false);
    expect(JSON.stringify(reply.json())).not.toContain('Venceu ontem');
  });

  it('answers 401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: awaitingUrl(), headers: { origin: TEST_APP_PUBLIC_URL } });

    expect(reply.statusCode).toBe(401);
  });

  it('gives a person of another agency nothing of this one', async () => {
    const reply = await read(people.adminB.cookie);

    expect(reply.statusCode).toBeGreaterThanOrEqual(403);
    expect(reply.statusCode).toBeLessThan(500);
    expect(JSON.stringify(reply.json())).not.toContain('Venceu ontem');
  });

  it('gives a person of two agencies the agency of the path and only it, in both directions', async () => {
    const inA = await read(people.dual.cookie, w.agencyA);
    const inB = await read(people.dual.cookie, w.agencyB);

    expect(idsOf(inA).sort()).toEqual(Object.values(ids).sort());
    expect(groupsOf(inB).map((group) => group.clientId)).toEqual([clientB]);
    expect(groupsOf(inB).flatMap((group) => group.contents.map((item) => item.title))).toEqual(['De outra agência']);
  });

  it('answers an empty list, not an error and not another agency\'s rows, to a person who lost the read between the guard and the query', async () => {
    const membership = await knex()('agency_memberships').where({ agency_id: w.agencyA, user_id: people.reader.id }).first('role_id');
    const roleId = membership?.role_id as string;
    w.runBeforeStatement(/content_approval_rounds/, async () => {
      await knex()('role_permissions').where({ role_id: roleId, permission_key: 'conteudo.visualizar' }).delete();
    });
    try {
      const reply = await read(people.reader.cookie);

      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({ data: [], meta: { truncated: false } });
    } finally {
      w.clearHook();
      await knex()('role_permissions').insert({ role_id: roleId, permission_key: 'conteudo.visualizar' }).onConflict().ignore();
    }
  });
});

describe('the ceiling of 50', () => {
  it('lists exactly 50 without saying it was cut, and cuts the 51st, the least urgent, saying so', async () => {
    const clientZ = await w.newClient('z');
    const count = async (): Promise<number> => idsOf(await read()).length;
    const before = await count();
    for (let index = before; index < 50; index += 1) {
      await seedWaiting(clientZ, `Cheio ${index}`, { dueOn: '2026-11-20', sentAt: '2026-11-08T12:00:00.000Z' });
    }

    const full = await read();
    expect(idsOf(full)).toHaveLength(50);
    expect(full.json().meta).toEqual({ truncated: false });

    const urgent = await seedWaiting(clientZ, 'Urgente', { dueOn: '2026-11-08', sentAt: '2026-11-08T12:00:00.000Z' });

    const cut = await read();
    expect(idsOf(cut)).toHaveLength(50);
    expect(cut.json().meta).toEqual({ truncated: true });
    // The least urgent goes: a deadline, however far, comes before a content with none, and a content with no round is the last of all.
    expect(idsOf(cut)).toContain(urgent);
    expect(idsOf(cut)).toContain(ids.noDue);
    expect(idsOf(cut)).not.toContain(ids.legacy);
    for (const group of groupsOf(cut)) expect(group.contents.length).toBeGreaterThan(0);
  }, 60_000);
});
