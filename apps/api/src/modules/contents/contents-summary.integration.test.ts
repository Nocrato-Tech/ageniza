import { contentIsScheduled, type ContentSummaryResponse } from '@ageniza/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TEST_APP_PUBLIC_URL } from '../auth/test-support/harness.js';
import { createContentsWorld, type Reply } from './test-support/world.js';

// Scope redesign-igual, subtask A2: the counters of the agency's Início (decisions 2026-11-11): "Esperando", "Atrasados", "Aprovados no mês"
// with the month before, and "Agendados" with the day of the last. The instant is the clock the module is given, so each edge of a day, a
// month or an hour is exact and no test depends on the hour it runs at. The days and months are those of America/Sao_Paulo, so most edges
// below sit between two instants that are on the same UTC day and on different days in São Paulo.
const w = createContentsWorld('summary');
const { people } = w;

const NOW = new Date('2026-11-10T01:30:00.000Z'); // 2026-11-09 22:30:00 in America/Sao_Paulo
let clock: Date | undefined;

const knex = () => w.getOwner().knex;
const summaryUrl = (agencyId = w.agencyA): string => `/agencies/${agencyId}/contents/summary`;
const read = (cookie = people.reader.cookie, agencyId = w.agencyA): Promise<Reply> => w.call('GET', cookie, summaryUrl(agencyId));
const dataOf = (reply: Reply): ContentSummaryResponse['data'] => reply.json<ContentSummaryResponse>().data;
const counters = async (at: Date = NOW): Promise<ContentSummaryResponse['data']> => {
  clock = at;
  const reply = await read();
  expect(reply.statusCode).toBe(200);
  return dataOf(reply);
};

let clientX: string;
let clientY: string;
let clientB: string;
let scheduledIds: Record<string, string>;

type Approval = { at: string; agencyReason?: string };
const approved = (
  clientId: string,
  approval: Approval,
  extra: { publishOn?: string; publishAtTime?: string | null; status?: 'approved' | 'published'; ownerUserId?: string } = {}
): Promise<string> =>
  w.seedContent(clientId, {
    status: extra.status ?? 'approved', publishOn: extra.publishOn ?? '2026-10-20', publishAtTime: extra.publishAtTime ?? null, approval,
    ...(extra.ownerUserId === undefined ? {} : { ownerUserId: extra.ownerUserId })
  });

beforeAll(async () => {
  await w.setup({ contentsClock: () => clock ?? new Date() });
  clientX = await w.newClient('x');
  clientY = await w.newClient('y');
  clientB = await w.newClient('b', { agencyId: w.agencyB });
  clock = NOW;

  // Waiting for the client: three, one of them late (its publication day, the 8th, passed); the 9th is today and is not late.
  await w.seedContent(clientX, { status: 'awaiting_approval', publishOn: '2026-11-08' });
  await w.seedContent(clientY, { status: 'awaiting_approval', publishOn: '2026-11-09' });
  await w.seedContent(clientY, { status: 'awaiting_approval', publishOn: '2026-11-20' });

  // Approved in November (São Paulo): the first minute of the month, the last minute of it (an instant that is already December in UTC),
  // a published one, and one approved by the agency outside the platform.
  await approved(clientX, { at: '2026-11-01T03:00:00.000Z' });
  await approved(clientX, { at: '2026-12-01T02:59:00.000Z' });
  await approved(clientY, { at: '2026-11-05T12:00:00.000Z' }, { status: 'published' });
  await approved(clientY, { at: '2026-11-03T12:00:00.000Z', agencyReason: 'Aprovado por telefone' });
  // Approved in October: the first minute of it, and a day in the middle.
  await approved(clientX, { at: '2026-10-01T03:00:00.000Z' });
  await approved(clientY, { at: '2026-10-15T12:00:00.000Z' });
  // Out of both months: the last minute of September in São Paulo (already October in UTC), another day of September, the first minute of December.
  await approved(clientX, { at: '2026-10-01T02:59:00.000Z' });
  await approved(clientX, { at: '2026-09-30T12:00:00.000Z' });
  await approved(clientX, { at: '2026-12-01T03:00:00.000Z' });

  // Scheduled: an approved content with an hour whose instant has not passed. The approvals are in September so they count in no month.
  const sep = { at: '2026-09-15T12:00:00.000Z' };
  scheduledIds = {
    laterToday: await approved(clientX, sep, { publishOn: '2026-11-09', publishAtTime: '23:00' }),
    nextMinuteToday: await approved(clientX, sep, { publishOn: '2026-11-09', publishAtTime: '22:31' }),
    thisMinute: await approved(clientX, sep, { publishOn: '2026-11-09', publishAtTime: '22:30' }),
    earlierToday: await approved(clientX, sep, { publishOn: '2026-11-09', publishAtTime: '22:00' }),
    tomorrow: await approved(clientY, sep, { publishOn: '2026-11-12', publishAtTime: '08:00' }),
    far: await approved(clientY, sep, { publishOn: '2026-12-05', publishAtTime: '10:00' }),
    noHour: await approved(clientY, sep, { publishOn: '2026-12-20', publishAtTime: null }),
    yesterday: await approved(clientY, sep, { publishOn: '2026-11-08', publishAtTime: '23:59' }),
    published: await approved(clientY, sep, { publishOn: '2026-12-25', publishAtTime: '10:00', status: 'published' })
  };
  await w.seedContent(clientY, { status: 'awaiting_approval', publishOn: '2026-12-30', publishAtTime: '10:00' });
  await w.seedContent(clientY, { status: 'in_production', publishOn: '2026-12-31', publishAtTime: '10:00' });

  // Nothing of these counts: a client the agency no longer asks for anything, and another agency.
  const archived = await w.newClient('archived');
  await w.seedContent(archived, { status: 'awaiting_approval', publishOn: '2026-11-01' });
  await approved(archived, { at: '2026-11-04T12:00:00.000Z' }, { publishOn: '2026-12-31', publishAtTime: '09:00' });
  await knex()('clients').where({ id: archived }).update({ status: 'archived', archived_at: new Date() });
  await w.seedContent(clientB, { status: 'awaiting_approval', publishOn: '2026-11-01', ownerUserId: people.adminB.id });
  await approved(clientB, { at: '2026-11-04T12:00:00.000Z' }, { publishOn: '2026-12-31', publishAtTime: '09:00', ownerUserId: people.adminB.id });
}, 90_000);

afterEach(() => {
  clock = NOW;
});

afterAll(async () => {
  await w.teardown();
}, 60_000);

describe('what waits for the client, and what is late', () => {
  it('counts what awaits the client, and the part whose publication day passed in São Paulo', async () => {
    const data = await counters();

    // 3 waiting + the one of the scheduled block (December), none of the archived client's nor of another agency's.
    expect(data.awaitingClient).toBe(4);
    expect(data.overdueAwaitingClient).toBe(1);
  });

  it('moves the late ones when the day of São Paulo changes, though it is the same UTC day', async () => {
    expect((await counters(new Date('2026-11-10T02:59:00.000Z'))).overdueAwaitingClient).toBe(1); // 23:59 of the 9th: the 9th is still today
    expect((await counters(new Date('2026-11-10T03:00:00.000Z'))).overdueAwaitingClient).toBe(2); // 00:00 of the 10th: the 9th passed
  });
});

describe('approved in the month, and in the month before', () => {
  it('counts the approved and published contents by the day of São Paulo, edges included, and the approval outside the platform too', async () => {
    const data = await counters();

    expect(data.approvedThisMonth).toBe(4);
    expect(data.approvedLastMonth).toBe(2);
  });

  it('turns the month at midnight of São Paulo: 02:59Z of the 1st is still the last minute of the month before', async () => {
    const lastMinute = await counters(new Date('2026-12-01T02:59:00.000Z'));
    expect(lastMinute.approvedThisMonth).toBe(4);
    expect(lastMinute.approvedLastMonth).toBe(2);

    const december = await counters(new Date('2026-12-01T03:00:00.000Z'));
    expect(december.approvedThisMonth).toBe(1);
    expect(december.approvedLastMonth).toBe(4);
  });

  it('turns the year: January counts December as the month before, and the months of the year before as no month', async () => {
    const january = await counters(new Date('2027-01-15T12:00:00.000Z'));

    expect(january.approvedThisMonth).toBe(0);
    expect(january.approvedLastMonth).toBe(1);
  });

  it('counts by where the month stands: in October, October is this month and September, with the nine approvals of the block of scheduled, the one before', async () => {
    const october = await counters(new Date('2026-10-20T12:00:00.000Z'));

    expect(october.approvedThisMonth).toBe(2);
    expect(october.approvedLastMonth).toBe(2 + Object.keys(scheduledIds).length);
  });
});

describe('scheduled: approved, with an hour that has not come', () => {
  it('counts the approved contents with an hour that is still ahead, and gives the day of the last one', async () => {
    const data = await counters();

    // 23:00 and 22:31 today, the 12th, and the 5th of December. 22:30 is this very minute (it is not ahead), 22:00 passed, without an hour is
    // "Aprovado", and yesterday, published and awaiting are other states.
    expect(data.scheduled).toEqual({ count: 4, lastPublishOn: '2026-12-05' });
  });

  it('moves with the hour of São Paulo: a minute later the content of 22:31 is no longer ahead', async () => {
    expect((await counters(new Date('2026-11-10T01:30:59.000Z'))).scheduled.count).toBe(4); // 22:30:59, 22:31 is ahead
    expect((await counters(new Date('2026-11-10T01:31:00.000Z'))).scheduled.count).toBe(3); // 22:31:00: it is the very minute
    expect((await counters(new Date('2026-11-10T02:59:00.000Z'))).scheduled.count).toBe(2); // 23:59: the 23:00 passed too
  });

  it('moves with the day of São Paulo: at midnight of the 10th, the contents of the 9th are over', async () => {
    const data = await counters(new Date('2026-11-10T03:00:00.000Z'));

    expect(data.scheduled).toEqual({ count: 2, lastPublishOn: '2026-12-05' });
  });

  it('has no day to give when nothing is scheduled', async () => {
    expect((await counters(new Date('2027-01-15T12:00:00.000Z'))).scheduled).toEqual({ count: 0, lastPublishOn: null });
  });

  it('agrees with the definition of the contracts, for every content and every hour of a grid of instants', async () => {
    const rows = await knex()('contents').whereIn('id', Object.values(scheduledIds))
      .select('id', 'status', knex().raw('publish_on::text as publish_on'), knex().raw("to_char(publish_at_time, 'HH24:MI') as publish_at_time"));
    const instants = [
      '2026-11-08T14:00:00.000Z', '2026-11-09T02:59:00.000Z', '2026-11-09T03:00:00.000Z', '2026-11-09T11:00:00.000Z',
      '2026-11-10T01:00:00.000Z', '2026-11-10T01:31:00.000Z', '2026-11-10T02:00:00.000Z', '2026-11-10T02:59:59.000Z', '2026-11-12T10:59:59.000Z',
      '2026-11-12T11:00:00.000Z', '2026-12-05T12:59:00.000Z', '2026-12-05T13:00:00.000Z'
    ];
    for (const instant of instants) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(instant)).reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
      const now = { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
      const expected = rows.filter((row) => contentIsScheduled({
        status: row.status, publishOn: String(row.publish_on), publishAtTime: row.publish_at_time
      }, now));
      const count = (await counters(new Date(instant))).scheduled.count;

      expect(count, instant).toBe(expected.length);
    }
  });
});

describe('who sees it', () => {
  it('gives the counters to every person who may read the contents', async () => {
    for (const person of ['reader', 'admin', 'manager', 'production', 'owner'] as const) {
      const reply = await read(people[person].cookie);
      expect(reply.statusCode, person).toBe(200);
      expect(dataOf(reply).awaitingClient, person).toBe(4);
    }
  });

  it('answers exactly the counters of the contract, no id and no title of any content', async () => {
    const reply = await read();

    expect(Object.keys(reply.json().data).sort()).toEqual(['approvedLastMonth', 'approvedThisMonth', 'awaitingClient', 'overdueAwaitingClient', 'scheduled']);
    expect(Object.keys(reply.json().data.scheduled).sort()).toEqual(['count', 'lastPublishOn']);
    expect(Object.keys(reply.json())).toEqual(['data']);
  });

  it.each(['noContent', 'operateOnly'] as const)('answers 403 to %s, who cannot read the contents, before any statement of the module', async (person) => {
    w.statements.length = 0;

    const reply = await read(people[person].cookie);

    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('FORBIDDEN');
    expect(w.mentionsContents()).toBe(false);
  });

  it('answers 401 without a session', async () => {
    const reply = await w.getApp().app.inject({ method: 'GET', url: summaryUrl(), headers: { origin: TEST_APP_PUBLIC_URL } });

    expect(reply.statusCode).toBe(401);
  });

  it('gives a person of another agency nothing of this one', async () => {
    const reply = await read(people.adminB.cookie);

    expect(reply.statusCode).toBeGreaterThanOrEqual(403);
    expect(reply.statusCode).toBeLessThan(500);
    expect(reply.json().data).toBeUndefined();
  });

  it('gives a person of two agencies the counters of the agency of the path and only it, in both directions', async () => {
    const inA = dataOf(await read(people.dual.cookie, w.agencyA));
    const inB = dataOf(await read(people.dual.cookie, w.agencyB));

    expect(inA.awaitingClient).toBe(4);
    expect(inB).toEqual({ awaitingClient: 1, overdueAwaitingClient: 1, approvedThisMonth: 1, approvedLastMonth: 0, scheduled: { count: 1, lastPublishOn: '2026-12-31' } });
  });

  it('counts nothing, with no error, for a person who lost the read between the guard and the query', async () => {
    const membership = await knex()('agency_memberships').where({ agency_id: w.agencyA, user_id: people.reader.id }).first('role_id');
    const roleId = membership?.role_id as string;
    w.runBeforeStatement(/public\.contents\b/, async () => {
      await knex()('role_permissions').where({ role_id: roleId, permission_key: 'conteudo.visualizar' }).delete();
    });
    try {
      const reply = await read(people.reader.cookie);

      expect(reply.statusCode).toBe(200);
      expect(dataOf(reply)).toEqual({ awaitingClient: 0, overdueAwaitingClient: 0, approvedThisMonth: 0, approvedLastMonth: 0, scheduled: { count: 0, lastPublishOn: null } });
    } finally {
      w.clearHook();
      await knex()('role_permissions').insert({ role_id: roleId, permission_key: 'conteudo.visualizar' }).onConflict().ignore();
    }
  });
});
