import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Scope redesign-igual, subtask A2: "Parado no cliente" of the agency's Início (decisions 2026-11-10 and 2026-11-11). It lists what awaits the
// client under the permission and the policy that show the calendar, from the one sent longest ago to the newest, with the state of the
// deadline counted on the day of São Paulo. The instant is fixed by the clock the module is given, so a test that lives at 01:30Z (still the
// evening before in São Paulo) does not depend on the hour it runs at.
const w = createContentsWorld('awaiting');
const { people } = w;

const AT_0130Z = new Date('2026-11-10T01:30:00.000Z'); // 2026-11-09 22:30 in America/Sao_Paulo
let clock: Date | undefined;

const knex = () => w.getOwner().knex;
const awaitingUrl = (agencyId = w.agencyA): string => `/agencies/${agencyId}/contents/awaiting-client`;
const read = (cookie = people.reader.cookie, agencyId = w.agencyA): Promise<Reply> => w.call('GET', cookie, awaitingUrl(agencyId));

type Item = {
  id: string; title: string; sentAt: string | null; dueAt: string | null; dueOn: string | null; thumbnailAssetId: string | null;
  daysWaiting: number | null; daysToDue: number | null; daysLate: number | null;
};
type Group = { clientId: string; clientName: string; approvers: string[] | null; contents: Item[] };
const groupsOf = (reply: Reply): Group[] => reply.json().data;
const idsOf = (reply: Reply): string[] => groupsOf(reply).flatMap((group) => group.contents.map((item) => item.id));
const itemsById = (reply: Reply): Map<string, Item> => new Map(groupsOf(reply).flatMap((group) => group.contents).map((item) => [item.id, item]));

/** A content awaiting approval, with the round the owner writes by hand so the instant it was sent and the deadline are the ones the test names. */
const seedWaiting = async (
  clientId: string,
  title: string,
  round?: { dueAt: string | null; sentAt: string; note?: string | null },
  extra: { ownerUserId?: string; publishOn?: string; coverAssetId?: string } = {}
): Promise<string> => {
  const id = await w.seedContent(clientId, {
    status: 'awaiting_approval', title, publishOn: extra.publishOn ?? '2026-11-20',
    ...(extra.ownerUserId === undefined ? {} : { ownerUserId: extra.ownerUserId }),
    ...(extra.coverAssetId === undefined ? {} : { coverAssetId: extra.coverAssetId })
  });
  if (round !== undefined) {
    await knex()('content_approval_rounds').insert({
      batch_id: randomUUID(), client_id: clientId, content_id: id, sequence: 1,
      due_at: round.dueAt, due_on: round.dueAt === null ? null : knex().raw('app_private.sao_paulo_date(?::timestamptz)', [round.dueAt]),
      note: round.note ?? null, sent_by: people.manager.id, sent_at: round.sentAt
    });
  }
  return id;
};

const seedPortalPerson = w.seedPortalPerson;

let clientX: string;
let clientY: string;
let clientB: string;
let ids: Record<string, string>;
let assets: Record<string, string>;
let invitedEmail: string;
let ana: { id: string; email: string };

beforeAll(async () => {
  await w.setup({ contentsClock: () => clock ?? new Date() });
  clientX = await w.newClient('x');
  clientY = await w.newClient('y');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
  clock = AT_0130Z;

  const folderX = await w.folderOf(clientX);
  assets = {
    attached: await w.seedAsset(clientX, folderX),
    cover: await w.seedAsset(clientX, folderX),
    attachedBehindCover: await w.seedAsset(clientX, folderX),
    pending: await w.seedAsset(clientX, folderX, { status: 'pending' }),
    removed: await w.seedAsset(clientX, folderX, { removed: true }),
    confirmedAfterRemoved: await w.seedAsset(clientX, folderX)
  };

  ids = {
    overdue: await seedWaiting(clientY, 'Venceu ontem', { dueAt: '2026-11-09T02:59:00.000Z', sentAt: '2026-11-05T12:00:00.000Z' }, { publishOn: '2026-11-08' }),
    // The last minute of the 9th in São Paulo: 02:59Z of the 10th still counts as today.
    today: await seedWaiting(clientY, 'Vence hoje', { dueAt: '2026-11-10T02:59:00.000Z', sentAt: '2026-11-06T12:00:00.000Z' }, { publishOn: '2026-11-09' }),
    sentFirst: await seedWaiting(clientX, 'Enviado primeiro', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-06T13:00:00.000Z' }, { publishOn: '2026-11-01' }),
    // Sent after the one above, yet due sooner than it: the deadline does not order, the send date does.
    twoDays: await seedWaiting(clientX, 'Vence em dois dias', { dueAt: '2026-11-12T02:59:00.000Z', sentAt: '2026-11-07T12:00:00.000Z' }, { coverAssetId: assets.cover! }),
    // 00:00 of the 10th in São Paulo: the first minute of tomorrow.
    tomorrow: await seedWaiting(clientX, 'Vence amanhã', { dueAt: '2026-11-10T03:00:00.000Z', sentAt: '2026-11-08T12:00:00.000Z', note: 'Preciso até amanhã.' }, { publishOn: '2026-11-15' }),
    // The same send instant as the one above: the publication day breaks the tie.
    later: await seedWaiting(clientX, 'Vence em três dias', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-08T12:00:00.000Z' }, { publishOn: '2026-11-25' }),
    noDue: await seedWaiting(clientX, 'Sem prazo', { dueAt: null, sentAt: '2026-11-09T02:30:00.000Z' }),
    legacy: await seedWaiting(clientX, 'Antes das rodadas')
  };
  await w.attach(ids.tomorrow!, [assets.attached!]);
  await w.attach(ids.twoDays!, [assets.attachedBehindCover!]);
  await w.attach(ids.later!, [assets.pending!]);
  await w.attach(ids.sentFirst!, [assets.removed!, assets.confirmedAfterRemoved!]);

  // None of these awaits the client, or none is asked of a client the agency can still ask: they never show.
  await w.seedContent(clientX, { status: 'in_production', title: 'Em produção' });
  await w.seedContent(clientX, { status: 'adjusting', title: 'Em ajuste' });
  await w.seedContent(clientX, { status: 'approved', title: 'Aprovado' });
  await w.seedContent(clientX, { status: 'published', title: 'Publicado' });
  await w.seedContent(clientX, { status: 'cancelled', title: 'Cancelado' });
  const archived = await w.newClient('archived');
  await seedWaiting(archived, 'De cliente arquivado', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-08T12:00:00.000Z' });
  await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
  await seedWaiting(clientB, 'De outra agência', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-08T12:00:00.000Z' }, { ownerUserId: people.adminB.id });

  // The portal of client X: two who entered (in this order), one who left, one who never entered, one invited with no account. Y has nobody.
  ana = await seedPortalPerson(clientX, 'Ana Aprovadora');
  await seedPortalPerson(clientX, 'Beto Aprovador');
  await seedPortalPerson(clientX, 'Caio Removido', 'removed');
  await seedPortalPerson(clientX, 'Edu Nunca Entrou', 'not-entered');
  invitedEmail = `convidada-${randomUUID().slice(0, 8)}@approvers.test`;
  await knex()('client_portal_accesses').insert({ client_id: clientX, email: invitedEmail, status: 'active' });
  // One who entered and whose account was purged afterwards (the delete only the owner can make): the access keeps its entry date but has no account, so it has no name.
  const purged = await seedPortalPerson(clientX, 'Gil Conta Apagada');
  await knex()('client_memberships').where({ client_id: clientX, user_id: purged.id }).delete();
  await knex().raw('delete from auth."user" where id = ?', [purged.id]);
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
    const byId = itemsById(reply);
    expect(byId.get(ids.overdue!)).toMatchObject({ dueOn: '2026-11-08', daysToDue: -1 });
    expect(byId.get(ids.today!)).toMatchObject({ dueOn: '2026-11-09', daysToDue: 0 });
    expect(byId.get(ids.tomorrow!)).toMatchObject({ dueOn: '2026-11-10', daysToDue: 1 });
    expect(byId.get(ids.later!)).toMatchObject({ dueOn: '2026-11-12', daysToDue: 3 });
  });

  it('gives the deadline as the instant it was set with, and the day of São Paulo it falls on, one minute apart across midnight', async () => {
    const byId = itemsById(await read());

    expect(byId.get(ids.today!)).toMatchObject({ dueAt: '2026-11-10T02:59:00.000Z', dueOn: '2026-11-09' });
    expect(byId.get(ids.tomorrow!)).toMatchObject({ dueAt: '2026-11-10T03:00:00.000Z', dueOn: '2026-11-10' });
    expect(byId.get(ids.noDue!)).toMatchObject({ dueAt: null, dueOn: null });
  });

  it('counts the days waiting from the day the round was sent in São Paulo, with or without a deadline', async () => {
    const byId = itemsById(await read());

    expect(byId.get(ids.noDue!)).toMatchObject({ sentAt: '2026-11-09T02:30:00.000Z', dueOn: null, daysWaiting: 1, daysToDue: null });
    expect(byId.get(ids.later!)).toMatchObject({ daysWaiting: 1 });
    expect(byId.get(ids.overdue!)).toMatchObject({ daysWaiting: 4 });
  });

  it('counts the days late from the publication day, only once that day has passed', async () => {
    const byId = itemsById(await read());

    expect(byId.get(ids.overdue!)).toMatchObject({ daysLate: 1 });
    expect(byId.get(ids.sentFirst!)).toMatchObject({ daysLate: 8 });
    expect(byId.get(ids.today!)).toMatchObject({ daysLate: null });
    expect(byId.get(ids.tomorrow!)).toMatchObject({ daysLate: null });
    expect(byId.get(ids.legacy!)).toMatchObject({ daysLate: null });
  });

  it('moves the counts when the clock moves, and the same instant gives the same answer', async () => {
    clock = new Date('2026-11-10T04:00:00.000Z'); // 01:00 of the 10th in São Paulo
    const byId = itemsById(await read());

    expect(byId.get(ids.tomorrow!)).toMatchObject({ daysToDue: 0, daysWaiting: 2 });
    expect(byId.get(ids.overdue!)).toMatchObject({ daysToDue: -2, daysLate: 2 });
    expect(byId.get(ids.today!)).toMatchObject({ daysLate: 1 });
  });

  it('never counts negative days waiting, even for a round sent after the instant asked about', async () => {
    clock = new Date('2026-11-01T15:00:00.000Z');

    expect(itemsById(await read()).get(ids.later!)?.daysWaiting).toBe(0);
  });

  it('gives a content that waited before the rounds existed no date and no counts, and still lists it', async () => {
    expect(itemsById(await read()).get(ids.legacy!)).toMatchObject({
      title: 'Antes das rodadas', sentAt: null, dueAt: null, dueOn: null, daysWaiting: null, daysToDue: null
    });
  });

  it('orders by who has waited longest, the deadline having no say, and the publication day breaking a tie of the send instant', async () => {
    const groups = groupsOf(await read());

    expect(groups.map((group) => group.clientId)).toEqual([clientY, clientX]);
    expect(groups[0]!.clientName).toContain('Contents awaiting y');
    expect(groups[0]!.contents.map((item) => item.id)).toEqual([ids.overdue, ids.today]);
    // Without a send date, a content comes last: it has waited since before the rounds were kept.
    expect(groups[1]!.contents.map((item) => item.id)).toEqual([ids.sentFirst, ids.twoDays, ids.tomorrow, ids.later, ids.noDue, ids.legacy]);
    expect(Object.keys(groups[1]!.contents[0]!).sort()).toEqual([
      'daysLate', 'daysToDue', 'daysWaiting', 'dueAt', 'dueOn', 'format', 'id', 'publishOn', 'sentAt', 'thumbnailAssetId', 'title'
    ]);
    expect(Object.keys(groups[1]!).sort()).toEqual(['approvers', 'clientId', 'clientName', 'contents']);
  });

  it('gives the cover of each content: its own cover first, then its first confirmed media, never a pending or a removed one', async () => {
    const byId = itemsById(await read());

    expect(byId.get(ids.twoDays!)?.thumbnailAssetId).toBe(assets.cover);
    expect(byId.get(ids.tomorrow!)?.thumbnailAssetId).toBe(assets.attached);
    expect(byId.get(ids.sentFirst!)?.thumbnailAssetId).toBe(assets.confirmedAfterRemoved);
    expect(byId.get(ids.later!)?.thumbnailAssetId).toBeNull();
    expect(byId.get(ids.noDue!)?.thumbnailAssetId).toBeNull();
  });

  it('lists only what awaits the client, of clients still active, of this agency', async () => {
    const titles = groupsOf(await read()).flatMap((group) => group.contents.map((item) => item.title));

    expect(titles.sort()).toEqual([
      'Antes das rodadas', 'Enviado primeiro', 'Sem prazo', 'Venceu ontem', 'Vence amanhã', 'Vence em dois dias', 'Vence em três dias', 'Vence hoje'
    ].sort());
  });

  it('does not give the note, the batch or who sent it: this is a summary of the agency', async () => {
    const reply = await read();

    for (const secret of ['Preciso até amanhã.', people.manager.id, 'batch', 'sentBy', 'note']) expect(JSON.stringify(reply.json())).not.toContain(secret);
    expect(reply.json().meta).toEqual({ truncated: false });
  });
});

describe('who approves, for whoever may read the people of the portal', () => {
  it('names the active people of the portal who entered, in the order they were given the access, and nobody else', async () => {
    const withoutAccount = await knex()('client_portal_accesses').where({ client_id: clientX, user_id: null, status: 'active' }).whereNotNull('first_entered_at').count<Array<{ count: string }>>('id as count');
    expect(Number(withoutAccount[0]?.count)).toBe(1);

    const reply = await read(people.admin.cookie);

    expect(reply.statusCode).toBe(200);
    const byClient = new Map(groupsOf(reply).map((group) => [group.clientId, group]));
    expect(byClient.get(clientX)!.approvers).toEqual(['Ana Aprovadora', 'Beto Aprovador']);
    expect(byClient.get(clientY)!.approvers).toEqual([]);
  });

  it('gives names only: no e-mail, no id of a person, no state, not even of those who were left out', async () => {
    const text = JSON.stringify((await read(people.admin.cookie)).json());

    for (const secret of [ana.email, ana.id, invitedEmail, 'Caio Removido', 'Edu Nunca Entrou', 'first_entered', 'role', 'status']) expect(text).not.toContain(secret);
  });

  it('gives the owner the names too, and every other collaborator exactly what the calendar gives them', async () => {
    const reply = await read(people.owner.cookie);

    expect(new Map(groupsOf(reply).map((group) => [group.clientId, group])).get(clientX)!.approvers).toEqual(['Ana Aprovadora', 'Beto Aprovador']);
    expect(idsOf(reply).sort()).toEqual(Object.values(ids).sort());
  });

  it('gives a person who reads the contents but not the people of the portal the client alone: approvers is null, not an empty list', async () => {
    const reply = await read(people.reader.cookie);

    expect(reply.statusCode).toBe(200);
    expect(groupsOf(reply).map((group) => group.approvers)).toEqual([null, null]);
    expect(JSON.stringify(reply.json())).not.toContain('Ana Aprovadora');
  });

  it('keeps the names from a person who may only remove people of the portal, though the table of accesses lets that person read them', async () => {
    const membership = await knex()('agency_memberships').where({ agency_id: w.agencyA, user_id: people.reader.id }).first('role_id');
    const roleId = membership?.role_id as string;
    await knex()('role_permissions').insert({ role_id: roleId, permission_key: 'cliente.remover_usuario' });
    try {
      const reply = await read(people.reader.cookie);

      expect(reply.statusCode).toBe(200);
      expect(groupsOf(reply).map((group) => group.approvers)).toEqual([null, null]);

      await knex()('role_permissions').insert({ role_id: roleId, permission_key: 'cliente.convidar_usuario' });
      const granted = await read(people.reader.cookie);
      expect(new Map(groupsOf(granted).map((group) => [group.clientId, group])).get(clientX)!.approvers).toEqual(['Ana Aprovadora', 'Beto Aprovador']);
    } finally {
      await knex()('role_permissions').where({ role_id: roleId }).whereIn('permission_key', ['cliente.remover_usuario', 'cliente.convidar_usuario']).delete();
    }
  });

  it('names at most 50 people of a client, the first ones given the access', async () => {
    const clientMany = await w.newClient('many');
    for (let index = 1; index <= 51; index += 1) await seedPortalPerson(clientMany, `Aprovador ${String(index).padStart(2, '0')}`);
    await seedWaiting(clientMany, 'De cliente com muita gente', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-09T02:40:00.000Z' });

    const group = groupsOf(await read(people.admin.cookie)).find((entry) => entry.clientId === clientMany);

    expect(group!.approvers).toHaveLength(50);
    expect(group!.approvers![0]).toBe('Aprovador 01');
    expect(group!.approvers![49]).toBe('Aprovador 50');
    expect(group!.approvers).not.toContain('Aprovador 51');
  }, 60_000);
});

describe('who sees it', () => {
  it('lets a person who may read the contents see what the calendar shows them', async () => {
    for (const person of ['reader', 'admin', 'manager', 'production', 'owner'] as const) {
      const reply = await read(people[person].cookie);
      expect(reply.statusCode, person).toBe(200);
      expect(idsOf(reply).filter((id) => Object.values(ids).includes(id)).sort(), person).toEqual(Object.values(ids).sort());
    }
  });

  it.each(['noContent', 'operateOnly'] as const)('answers 403 to %s, who cannot read the contents, before any statement of the module', async (person) => {
    w.statements.length = 0;

    const reply = await read(people[person].cookie);

    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
    expect(w.mentionsContents()).toBe(false);
    expect(JSON.stringify(reply.json())).not.toContain('Venceu ontem');
    expect(JSON.stringify(reply.json())).not.toContain('Ana Aprovadora');
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
    expect(JSON.stringify(reply.json())).not.toContain('Ana Aprovadora');
  });

  it('gives a person of two agencies the agency of the path and only it, in both directions', async () => {
    const inA = await read(people.dual.cookie, w.agencyA);
    const inB = await read(people.dual.cookie, w.agencyB);

    expect(idsOf(inA).filter((id) => Object.values(ids).includes(id)).sort()).toEqual(Object.values(ids).sort());
    expect(groupsOf(inB).map((group) => group.clientId)).toEqual([clientB]);
    expect(groupsOf(inB).flatMap((group) => group.contents.map((item) => item.title))).toEqual(['De outra agência']);
    expect(groupsOf(inB)[0]!.approvers).toEqual([]);
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
  it('lists exactly 50 without saying it was cut, and cuts the newest past the 50th, saying so', async () => {
    const clientZ = await w.newClient('z');
    const count = async (): Promise<number> => idsOf(await read()).length;
    const before = await count();
    for (let index = before; index < 50; index += 1) {
      await seedWaiting(clientZ, `Cheio ${index}`, { dueAt: '2026-11-21T02:59:00.000Z', sentAt: '2026-11-08T12:00:00.000Z' });
    }

    const full = await read();
    expect(idsOf(full)).toHaveLength(50);
    expect(full.json().meta).toEqual({ truncated: false });
    expect(idsOf(full)).toContain(ids.legacy);

    // The 51st: it was sent last, but a content with no send date waits since before the rounds, so it is the one cut.
    const newest = await seedWaiting(clientZ, 'Recente', { dueAt: '2026-11-13T02:59:00.000Z', sentAt: '2026-11-09T03:00:00.000Z' });
    const firstCut = await read();
    expect(idsOf(firstCut)).toHaveLength(50);
    expect(firstCut.json().meta).toEqual({ truncated: true });
    expect(idsOf(firstCut)).toContain(newest);
    expect(idsOf(firstCut)).toContain(ids.noDue);
    expect(idsOf(firstCut)).not.toContain(ids.legacy);

    // The 52nd: now the newest of the sent ones goes too, however urgent its deadline is.
    const newer = await seedWaiting(clientZ, 'Mais recente e urgente', { dueAt: '2026-11-09T14:00:00.000Z', sentAt: '2026-11-09T04:00:00.000Z' });
    const cut = await read();
    expect(idsOf(cut)).toHaveLength(50);
    expect(cut.json().meta).toEqual({ truncated: true });
    expect(idsOf(cut)).toContain(newest);
    expect(idsOf(cut)).not.toContain(newer);
    expect(idsOf(cut)).not.toContain(ids.legacy);
    for (const group of groupsOf(cut)) expect(group.contents.length).toBeGreaterThan(0);
  }, 60_000);
});
