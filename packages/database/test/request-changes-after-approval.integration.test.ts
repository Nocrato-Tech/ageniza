import { createHash, randomUUID } from 'node:crypto';

import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalTestDatabaseClient, databaseErrorCode, resolveIntegrationDatabaseUrls, type DatabaseClient } from '../src/index.js';

import { createApprovalFixtures } from './support/approval-fixtures.js';
import { createLinkWorld, type LinkWorld } from './support/approval-link-world.js';
import { createContentWorld, type ContentStatus } from './support/content-world.js';
import { askedLaterThanTheStart, callAtInstant, type AtInstant } from './support/pinned-clock.js';

// Scope redesign-igual, subtask W11-S1 (decision 2026-11-13, "o cliente pede ajuste depois de aprovar até a véspera da publicação"): a content
// that is APPROVED takes a request for changes while its planned day is after today in São Paulo, and not on the day itself. It goes to
// "adjusting" like the one that waited for approval, through the account of the portal (`request_content_changes`) only. The link of the e-mail
// (`request_changes_by_portal_approval`) keeps deciding only a content that awaits approval, and is tested to refuse the approved one. Both are
// attacked as `ageniza_app`; the owner prepares the world and reads what was left. `now()` cannot be pinned, so the day is read from the database (`a.day`) and the edges are tried at fixed instants through a
// stand-in of `app_private.sao_paulo_date` inside a transaction that is rolled back (the way `client-dates` does it).
const w = createContentWorld('w11s1-changes');
const { ids } = w;
const a = createApprovalFixtures(w);
const { applicationUrl } = resolveIntegrationDatabaseUrls();
const owner = (): Knex => w.getOwner().knex;

let worker: DatabaseClient;

beforeAll(async () => {
  await w.setup();
  worker = createLocalTestDatabaseClient(applicationUrl);
  await a.waitForQuietClock();
}, 300_000);

afterAll(async () => {
  try {
    await a.cleanUp();
  } finally {
    await worker.close();
    await w.teardown();
  }
});

// ---- helpers ------------------------------------------------------------------------------------------------------------------

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const asApp = <T>(work: (transaction: Knex.Transaction) => Promise<T>): Promise<T> => worker.knex.transaction(work);

const COMMENT = 'Troque a foto da capa';

type Row = Record<string, unknown>;
const rowOf = (content: string): Promise<Row> => w.contentRow(content);
const threadsOf = (content: string): Promise<Row[]> => owner()('client_threads').where({ content_id: content }) as Promise<Row[]>;
const commentsOf = async (content: string): Promise<Row[]> =>
  (await owner().raw<{ rows: Row[] }>(`
    select comment.author_side, comment.body, comment.author_user_id, comment.author_portal_access_id
    from public.client_thread_comments comment join public.client_threads thread on thread.id = comment.thread_id
    where thread.content_id = ?::uuid order by comment.created_at, comment.id
  `, [content])).rows;
const notificationsOf = (content: string): Promise<Row[]> =>
  owner()('notifications').where({ content_id: content }).select('kind', 'recipient_user_id', 'client_id') as Promise<Row[]>;
const attach = async (content: string, clientId: string): Promise<void> => {
  await w.attach(content, [await w.seedAsset(clientId, await w.folderOf(clientId), { category: 'video' })]);
};

// ---- the two doors, behind one shape -----------------------------------------------------------------------------------------

interface AskOptions { readonly revision?: number; readonly body?: string | null }

type AtResult = AtInstant<{ readonly row: Row; readonly later: boolean }>;

interface Channel {
  readonly name: string;
  readonly clientId: string;
  /** What a content in production answers: the portal does not know it exists, the link was given it in its batch. */
  readonly inProductionCode: 'A0060' | 'A0062';
  seed(status: ContentStatus, day: string, extra?: Parameters<typeof w.seedContent>[1]): Promise<string>;
  ask(content: string, options?: AskOptions): Promise<unknown>;
  /** The call at a fixed instant: `sao_paulo_date` is a stand-in that answers the day of `instant` and records what it was asked. */
  askAt(instant: string, content: string, options?: AskOptions): Promise<AtResult>;
}

/** The call at a fixed instant, as `ageniza_app`, and what it left in the transaction that is rolled back. */
const atInstant = (instant: string, actor: string | null, content: string, call: (transaction: Knex.Transaction) => Promise<unknown>): Promise<AtResult> =>
  callAtInstant(owner(), instant, actor, call, async (transaction) => ({
    later: await askedLaterThanTheStart(transaction),
    row: (await transaction.raw<{ rows: Row[] }>(
      'select status, approved_by, approved_by_portal_access_id, approved_at, approved_by_agency_reason, revision from public.contents where id = ?::uuid', [content]
    )).rows[0]!
  }));

const revisionOf = async (content: string): Promise<number> => (await rowOf(content)).revision as number;

const portalChannel = (): Channel => {
  const user = ids.portalA1;
  const call = (content: string, revision: number, body: string | null) => (transaction: Knex.Transaction) =>
    transaction.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision, body]);
  return {
    name: 'the portal',
    clientId: ids.clientA1,
    inProductionCode: 'A0060',
    seed: (status, day, extra) => w.seedContent(ids.clientA1, { status, publishOn: day, ...extra }),
    ask: async (content, options = {}) =>
      w.asUser(user, async (transaction) => call(content, options.revision ?? await revisionOf(content), options.body === undefined ? COMMENT : options.body)(transaction)),
    askAt: async (instant, content, options = {}) =>
      atInstant(instant, user, content, call(content, options.revision ?? 1, options.body === undefined ? COMMENT : options.body))
  };
};

const linkWorld = (): Promise<LinkWorld> => createLinkWorld(w, a, worker);

const linkChannel = async (): Promise<Channel & { readonly world: LinkWorld }> => {
  const world = await linkWorld();
  const call = (content: string, revision: number, body: string | null) => (transaction: Knex.Transaction) =>
    transaction.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, ?::integer, ?)', [world.sessionHash, content, revision, body]);
  return {
    world,
    name: 'the approval link',
    clientId: world.clientId,
    inProductionCode: 'A0062',
    seed: async (status, day, extra) => {
      const content = await w.seedContent(world.clientId, { status, publishOn: day, ...extra });
      await owner()('client_portal_approval_link_contents').insert({ link_id: world.linkId, content_id: content, client_id: world.clientId });
      return content;
    },
    ask: async (content, options = {}) =>
      asApp(async (transaction) => call(content, options.revision ?? await revisionOf(content), options.body === undefined ? COMMENT : options.body)(transaction)),
    askAt: async (instant, content, options = {}) =>
      atInstant(instant, null, content, call(content, options.revision ?? 1, options.body === undefined ? COMMENT : options.body))
  };
};

const attempt = (work: Promise<unknown>): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string | undefined }> =>
  work.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, code: databaseErrorCode(error) }));

const NOT_CLEARED = { approved_by: null, approved_by_portal_access_id: null, approved_at: null, approved_by_agency_reason: null };

// ---- the rule, by the day of São Paulo, at the clock of the database -------------------------------------------------------------

describe('the portal: a request for changes on a content, state by state and day by day', () => {
  const c = portalChannel();

  it.each([
    ['tomorrow', 1], ['in two days', 2], ['in a month', 30], ['next year', 365]
  ] as const)('accepts an approved content planned for %s, and moves it to adjusting like the one that waited for approval', async (_label, offset) => {
    const content = await c.seed('approved', await a.day(offset));
    const before = await rowOf(content);

    await c.ask(content);

    const after = await rowOf(content);
    expect(after).toMatchObject({ status: 'adjusting', revision: before.revision, publish_on: before.publish_on, ...NOT_CLEARED });
    expect(before).toMatchObject({ status: 'approved', approved_by: ids.portalA1 });
    expect(await threadsOf(content)).toHaveLength(1);
    expect(await commentsOf(content)).toMatchObject([{ author_side: 'client', body: COMMENT }]);
    expect(await notificationsOf(content)).toEqual([{ kind: 'content_changes_requested', recipient_user_id: ids.productionA, client_id: c.clientId }]);
  });

  it.each([
    ['today', 0], ['yesterday', -1], ['a month ago', -30]
  ] as const)('refuses an approved content planned for %s with A0062, and leaves the content, the conversation and the notifications as they were', async (_label, offset) => {
    const content = await c.seed('approved', await a.day(offset));
    const before = await rowOf(content);

    await expect(c.ask(content)).rejects.toMatchObject({ code: 'A0062' });

    expect(await rowOf(content)).toEqual(before);
    expect(await threadsOf(content)).toEqual([]);
    expect(await commentsOf(content)).toEqual([]);
    expect(await notificationsOf(content)).toEqual([]);
  });

  it.each([
    ['planned far ahead', 365], ['planned for tomorrow', 1], ['planned for today', 0], ['planned in the past', -30]
  ] as const)('keeps accepting a content awaiting approval whatever its day: %s (what the request always did)', async (_label, offset) => {
    const content = await c.seed('awaiting_approval', await a.day(offset));

    await c.ask(content);

    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toHaveLength(1);
  });

  it.each([
    ['adjusting', 'adjusting'], ['published', 'published']
  ] as const)('refuses a content that is %s with A0062 whatever its day, leaving it as it was', async (_label, status) => {
    for (const offset of [-30, 0, 1, 365]) {
      const content = await c.seed(status, await a.day(offset));
      const before = await rowOf(content);

      await expect(c.ask(content), `${status} ${offset}`).rejects.toMatchObject({ code: 'A0062' });

      expect(await rowOf(content)).toEqual(before);
      expect(await threadsOf(content)).toEqual([]);
      expect(await notificationsOf(content)).toEqual([]);
    }
  });

  it('answers a content in production as before, and a cancelled one as "not found", whatever its day', async () => {
    for (const offset of [-30, 0, 365]) {
      const production = await c.seed('in_production', await a.day(offset));
      await expect(c.ask(production), `in production ${offset}`).rejects.toMatchObject({ code: c.inProductionCode });
      const cancelled = await c.seed('cancelled', await a.day(offset));
      await expect(c.ask(cancelled), `cancelled ${offset}`).rejects.toMatchObject({ code: 'A0060' });
      expect(await rowOf(production)).toMatchObject({ status: 'in_production' });
      expect(await rowOf(cancelled)).toMatchObject({ status: 'cancelled' });
    }
  });

  it('refuses a comment that is blank or too long on an approved content planned for a later day, leaving it approved', async () => {
    const content = await c.seed('approved', await a.day(3));
    const before = await rowOf(content);

    for (const body of [null, '', '   ', 'a'.repeat(5001)]) {
      await expect(c.ask(content, { body }), String(body?.length)).rejects.toMatchObject({ code: 'A0068' });
    }

    expect(await rowOf(content)).toEqual(before);
    expect(await threadsOf(content)).toEqual([]);
  });

  it('refuses a revision that is not the one the person saw, on an approved content of a later day, with A0063', async () => {
    const content = await c.seed('approved', await a.day(3));
    const before = await rowOf(content);

    await expect(c.ask(content, { revision: 99 })).rejects.toMatchObject({ code: 'A0063' });

    expect(await rowOf(content)).toEqual(before);
    expect(await threadsOf(content)).toEqual([]);
  });

  it('judges the state before the revision: the day of the publication is A0062 even for a revision that is not current', async () => {
    const content = await c.seed('approved', await a.day(0));

    await expect(c.ask(content, { revision: 99 })).rejects.toMatchObject({ code: 'A0062' });
  });

  it('turns an approval given by the agency, with its reason, into a content in adjustment that carries no approval at all', async () => {
    const id = randomUUID();
    await owner()('contents').insert({
      id, client_id: c.clientId, title: 'Aprovado pela agência', platform: 'instagram', format: 'reels', publish_on: await a.day(4),
      folder_id: await w.folderOf(c.clientId), owner_user_id: ids.productionA, status: 'approved', approved_by: ids.adminA,
      approved_at: new Date('2026-11-01T12:00:00.000Z'), approved_by_agency_reason: 'Aprovado por telefone'
    });

    await c.ask(id);

    expect(await rowOf(id)).toMatchObject({ status: 'adjusting', ...NOT_CLEARED });
  });
});

// ---- what the request leaves, and what comes after it --------------------------------------------------------------------------

describe('what the request after an approval leaves, and the way back to the client', () => {
  const portal = portalChannel();

  it('keeps the note the client gave when approving: the conversation holds the note and the request, both as the client, in that order', async () => {
    const content = await portal.seed('awaiting_approval', await a.day(5));
    await w.asUser(ids.portalA1, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, 1, 'Gostei, mas ainda vou pensar']));
    expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by: ids.portalA1 });

    await w.asUser(ids.portalA1Second, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, 'Troque a cor da capa']));

    expect(await threadsOf(content)).toHaveLength(1);
    expect(await commentsOf(content)).toEqual([
      { author_side: 'client', body: 'Gostei, mas ainda vou pensar', author_user_id: ids.portalA1, author_portal_access_id: null },
      { author_side: 'client', body: 'Troque a cor da capa', author_user_id: ids.portalA1Second, author_portal_access_id: null }
    ]);
    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', ...NOT_CLEARED });
  });

  it('lets the agency send it again in a new round, and the client approve again: the approval is a new one, not the one that was undone', async () => {
    const content = await portal.seed('approved', await a.day(5));
    await attach(content, ids.clientA1);
    await w.asUser(ids.portalA1, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, 'Mais luz na foto']));
    expect(await a.roundsOf(content)).toEqual([]);

    await a.submit(ids.productionA, content, await a.day(3), 'Ajustado');

    expect(await rowOf(content)).toMatchObject({ status: 'awaiting_approval', ...NOT_CLEARED });
    expect((await a.roundsOf(content)).map((round) => round.note)).toEqual(['Ajustado']);
    await w.asUser(ids.portalA1Second, (t) => t.raw('select app_private.approve_content(?::uuid, ?::integer, ?::text)', [content, 1, null]));
    const approved = await rowOf(content);
    expect(approved).toMatchObject({ status: 'approved', approved_by: ids.portalA1Second });
    expect((approved.approved_at as Date).getTime()).toBeGreaterThan(new Date('2026-11-12T00:00:00.000Z').getTime());
  });

  it('does not change the day, the hour, the caption, the title or the revision, and says "pediu ajuste" to the person in charge, once', async () => {
    const content = await portal.seed('approved', await a.day(6), { publishAtTime: '09:15', caption: 'Legenda que o cliente aprovou' });
    const before = await rowOf(content);

    await w.asUser(ids.portalA1, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, 1, COMMENT]));

    const unchanged = Object.fromEntries(Object.entries(before).filter(([key]) => !['status', 'approved_by', 'approved_at'].includes(key)));
    expect(await rowOf(content)).toMatchObject(unchanged);
    const notifications = await owner()('notifications').where({ content_id: content }).select('kind', 'recipient_user_id', 'summary');
    expect(notifications).toEqual([{ kind: 'content_changes_requested', recipient_user_id: ids.productionA, summary: expect.stringContaining('pediu ajuste') }]);
  });

  it('opens the transition approved -> adjusting for no other writer than the two functions: the application role has no grant on the state', async () => {
    expect(await w.columnsWithPrivilege('contents', 'update')).not.toContain('status');
    const content = await portal.seed('approved', await a.day(6));
    await expect(w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ status: 'adjusting' }))).rejects.toMatchObject({ code: '42501' });
    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
  });

  it('clears the approval when the owner moves a content from approved to adjusting, like the move back to awaiting approval', async () => {
    const content = await portal.seed('approved', await a.day(6));

    await owner().transaction(async (transaction) => {
      await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
      await transaction('contents').where({ id: content }).update({ status: 'adjusting', approved_by: ids.adminA });
    });

    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', ...NOT_CLEARED });
  });

  it('still refuses every other move the life cycle did not have, after the new one', async () => {
    for (const [from, to] of [['published', 'adjusting'], ['cancelled', 'adjusting'], ['in_production', 'adjusting'], ['adjusting', 'approved'], ['approved', 'in_production']] as const) {
      const content = await portal.seed(from, await a.day(6));
      await expect(owner().transaction(async (transaction) => {
        await transaction.raw('select app_private.bind_actor(?::uuid)', [ids.adminA]);
        await transaction('contents').where({ id: content }).update({ status: to });
      }), `${from} -> ${to}`).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('life cycle') });
    }
  });
});

// ---- the same people and the same refusals as before -----------------------------------------------------------------------------

describe('who may ask for changes on an approved content (the portal), unchanged by the new state', () => {
  const portal = portalChannel();
  const ask = (user: string, content: string, revision = 1): Promise<unknown> =>
    w.asUser(user, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [content, revision, COMMENT]));

  it.each([
    ['another person of the portal of the same client', () => ids.portalA1Second],
    ['a collaborator with a link to the client and a role without conteudo.*, who is an active person of the portal', () => ids.dualBare],
    ['a collaborator with the Production role and a link to the client', () => ids.dualFull],
    ['an Admin of another agency who holds a link to the client', () => ids.crossDual]
  ] as const)('lets %s ask, writing the comment as the client by who asked', async (_label, user) => {
    const content = await portal.seed('approved', await a.day(2));

    await ask(user(), content);

    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
    expect(await commentsOf(content)).toMatchObject([{ author_side: 'client', author_user_id: user(), body: COMMENT }]);
  });

  it.each([
    ['a person of the portal of another client of the same agency', () => ids.portalA2],
    ['a person of the portal of a client of another agency', () => ids.portalB],
    ['an Admin of the agency, who holds every permission but has no link to the client', () => ids.adminA],
    ['the Owner of the agency, who has no link to the client', () => ids.ownerA],
    ['Production, who has no link to the client', () => ids.productionA],
    ['an Admin whose link to the client was removed', () => ids.dualRemoved]
  ] as const)('answers "not found" to %s, leaving the approved content approved', async (_label, user) => {
    const content = await portal.seed('approved', await a.day(2));
    const before = await rowOf(content);

    await expect(ask(user(), content)).rejects.toMatchObject({ code: 'A0060' });

    expect(await rowOf(content)).toEqual(before);
    expect(await threadsOf(content)).toEqual([]);
  });

  it('answers "not found" for a content that does not exist, the same as for the one it cannot see', async () => {
    await expect(ask(ids.portalA1, randomUUID())).rejects.toMatchObject({ code: 'A0060' });
  });

  it('does not ask for changes for a client that is archived, or for an agency that is suspended, even on an approved content of a later day', async () => {
    const archived = await w.seedContent(ids.clientArchived, { status: 'approved', publishOn: await a.day(3) });
    const { control, suspended } = await w.withSuspendedAgencyActive(async () => {
      const control = await w.seedContent(ids.clientSuspended, { status: 'approved', publishOn: await a.day(3), owner: ids.adminSuspended });
      const suspended = await w.seedContent(ids.clientSuspended, { status: 'approved', publishOn: await a.day(3), owner: ids.adminSuspended });
      await ask(ids.portalSuspended, control);
      return { control, suspended };
    });
    expect(await rowOf(control)).toMatchObject({ status: 'adjusting' });
    await w.archiveClient(ids.clientArchived);

    try {
      await expect(ask(ids.portalArchived, archived)).rejects.toMatchObject({ code: 'A0060' });
      await expect(ask(ids.portalSuspended, suspended)).rejects.toMatchObject({ code: 'A0060' });
    } finally {
      await w.reactivateClient(ids.clientArchived);
    }
    expect(await rowOf(archived)).toMatchObject({ status: 'approved' });
    expect(await rowOf(suspended)).toMatchObject({ status: 'approved' });
    expect(await threadsOf(suspended)).toEqual([]);
  });

  it('refuses a read-only agency the way it refuses the request on a content awaiting approval (A0090), and writes nothing', async () => {
    const approved = await portal.seed('approved', await a.day(3));
    const waiting = await portal.seed('awaiting_approval', await a.day(3));
    await owner()('agencies').where({ id: ids.agencyA }).update({
      plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
    });
    try {
      const forWaiting = await attempt(ask(ids.portalA1, waiting));
      const forApproved = await attempt(ask(ids.portalA1, approved));
      expect(forWaiting).toEqual({ ok: false, code: 'A0090' });
      expect(forApproved).toEqual(forWaiting);
    } finally {
      await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null, status: 'active' });
    }
    expect(await rowOf(approved)).toMatchObject({ status: 'approved' });
    expect(await threadsOf(approved)).toEqual([]);
  });

  it('refuses the request after the agency edited the caption of the approved content, which sent it back to waiting with a new revision, by revision only', async () => {
    const content = await portal.seed('approved', await a.day(3));
    await w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ caption: 'Outra legenda' }));
    expect(await rowOf(content)).toMatchObject({ status: 'awaiting_approval', revision: 2 });

    await expect(ask(ids.portalA1, content, 1)).rejects.toMatchObject({ code: 'A0063' });
    await ask(ids.portalA1, content, 2);

    expect(await rowOf(content)).toMatchObject({ status: 'adjusting', revision: 2 });
  });

  it('refuses the request after the agency moved the day of the approved content to today, and accepts it again when the day moves back', async () => {
    const content = await portal.seed('approved', await a.day(3));
    await w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ publish_on: t.raw('app_private.sao_paulo_date(pg_catalog.now())') }));
    await expect(ask(ids.portalA1, content)).rejects.toMatchObject({ code: 'A0062' });

    await w.asUser(ids.productionA, (t) => t('contents').where({ id: content }).update({ publish_on: t.raw('app_private.sao_paulo_date(pg_catalog.now()) + 1') }));
    await ask(ids.portalA1, content);

    expect(await rowOf(content)).toMatchObject({ status: 'adjusting' });
  });
});

// The link of the e-mail decides only a content that awaits approval (decisions 2026-10-26 item 4, 2026-10-27 item 6 and 2026-11-06): the
// rule of "until the eve" is the portal's, for a person with an account.
describe('the approval link decides only a content that awaits approval, and takes no part in the request after an approval', () => {
  let link: Awaited<ReturnType<typeof linkChannel>>;
  beforeAll(async () => {
    link = await linkChannel();
  }, 120_000);

  const askWith = (sessionHash: string, content: string, revision = 1): Promise<unknown> =>
    asApp((t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, ?::integer, ?)', [sessionHash, content, revision, COMMENT]));

  const refused = async (content: string, label: string): Promise<void> => {
    const before = await rowOf(content);
    const notified = await notificationsOf(content);
    await expect(link.ask(content), label).rejects.toMatchObject({ code: 'A0062' });
    expect(await rowOf(content), label).toEqual(before);
    expect(await threadsOf(content), label).toEqual([]);
    expect(await commentsOf(content), label).toEqual([]);
    expect(await notificationsOf(content), label).toEqual(notified);
  };

  it('L1: refuses, with A0062 and no change, the content that the same link approved, on any planned day', async () => {
    for (const offset of [-1, 0, 1, 30, 365]) {
      const content = await link.seed('awaiting_approval', await a.day(offset));
      await asApp((t) => t.raw('select app_private.approve_content_by_portal_approval(?, ?::uuid, 1)', [link.world.sessionHash, content]));
      expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by: null, approved_by_portal_access_id: link.world.accessId });

      await refused(content, `L1 ${offset}`);
      expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by_portal_access_id: link.world.accessId });
    }
  });

  it('L2: refuses the content that a person of the portal approved with an account, and leaves the approval of that person', async () => {
    for (const offset of [0, 1, 30]) {
      const content = await link.seed('approved', await a.day(offset), { approvedBy: ids.portalA1 });

      await refused(content, `L2 ${offset}`);
      expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by: ids.portalA1 });
    }
  });

  it('L3: refuses the content that the agency approved with a reason, and keeps the reason', async () => {
    for (const offset of [0, 1, 30]) {
      const content = await link.seed('awaiting_approval', await a.day(offset));
      await w.asUser(ids.adminA, (t) => t.raw('select app_private.approve_content_by_agency(?::uuid, ?::integer, ?::text)', [content, 1, 'Aprovado por WhatsApp']));
      expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by_agency_reason: 'Aprovado por WhatsApp' });

      await refused(content, `L3 ${offset}`);
      expect(await rowOf(content)).toMatchObject({ status: 'approved', approved_by: ids.adminA, approved_by_agency_reason: 'Aprovado por WhatsApp' });
    }
  });

  it('refuses an approved content on any day while the portal accepts the same content on a later day, side by side', async () => {
    const portal = portalChannel();
    for (const offset of [1, 3, 365]) {
      const byLink = await link.seed('approved', await a.day(offset));
      const byPortal = await portal.seed('approved', await a.day(offset));
      expect(await attempt(link.ask(byLink)), `link ${offset}`).toEqual({ ok: false, code: 'A0062' });
      expect(await attempt(portal.ask(byPortal)), `portal ${offset}`).toEqual({ ok: true });
    }
  });

  it('keeps asking for changes on a content awaiting approval whatever its day, as the writer of the comment, with no account', async () => {
    for (const offset of [-30, 0, 1, 365]) {
      const content = await link.seed('awaiting_approval', await a.day(offset));

      await link.ask(content);

      expect(await rowOf(content), String(offset)).toMatchObject({ status: 'adjusting', ...NOT_CLEARED });
      expect(await threadsOf(content)).toMatchObject([{ opened_by: null, opened_by_portal_access_id: link.world.accessId, opened_side: 'client' }]);
      expect(await commentsOf(content)).toEqual([{ author_side: 'client', body: COMMENT, author_user_id: null, author_portal_access_id: link.world.accessId }]);
    }
  });

  it('refuses a content in adjustment, published or in production with A0062, whatever its day, and a cancelled one as "not found"', async () => {
    for (const offset of [-30, 0, 1, 365]) {
      for (const status of ['adjusting', 'published', 'in_production'] as const) await refused(await link.seed(status, await a.day(offset)), `${status} ${offset}`);
      await expect(link.ask(await link.seed('cancelled', await a.day(offset)))).rejects.toMatchObject({ code: 'A0060' });
    }
  });

  it('judges the state before the revision: an approved content is A0062 even for a revision that is not current', async () => {
    const content = await link.seed('approved', await a.day(3));

    await expect(link.ask(content, { revision: 99 })).rejects.toMatchObject({ code: 'A0062' });
  });

  it('refuses a comment that is blank or too long, and a revision that is not current, on a content awaiting approval, as before', async () => {
    const content = await link.seed('awaiting_approval', await a.day(3));

    for (const body of [null, '', '   ', 'a'.repeat(5001)]) {
      await expect(link.ask(content, { body }), String(body?.length)).rejects.toMatchObject({ code: 'A0068' });
    }
    await expect(link.ask(content, { revision: 99 })).rejects.toMatchObject({ code: 'A0063' });

    expect(await rowOf(content)).toMatchObject({ status: 'awaiting_approval' });
    expect(await threadsOf(content)).toEqual([]);
  });

  it('refuses an approved content that is not in the batch of the link: another content of the client and a content of another client', async () => {
    const outside = await w.seedContent(link.clientId, { status: 'approved', publishOn: await a.day(3) });
    const otherClient = await w.seedContent(ids.clientA2, { status: 'approved', publishOn: await a.day(3) });

    for (const content of [outside, otherClient]) {
      await expect(askWith(link.world.sessionHash, content)).rejects.toMatchObject({ code: 'A0060' });
      expect(await rowOf(content)).toMatchObject({ status: 'approved' });
    }
  });

  it('refuses the session of another link for a content of this one: it is "not found", and nothing moved', async () => {
    const other = await linkWorld();
    const content = await link.seed('approved', await a.day(3));

    await expect(askWith(other.sessionHash, content)).rejects.toMatchObject({ code: 'A0060' });

    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
  });

  it('refuses a session that is not one, and a call with an account bound, leaving the approved content as it was', async () => {
    const content = await link.seed('approved', await a.day(3));

    await expect(askWith(sha('not a session'), content)).rejects.toMatchObject({ code: 'A0100' });
    await expect(w.asUser(ids.adminA, (t) => t.raw('select app_private.request_changes_by_portal_approval(?, ?::uuid, 1, ?)', [link.world.sessionHash, content, COMMENT])))
      .rejects.toMatchObject({ code: '42501' });

    expect(await rowOf(content)).toMatchObject({ status: 'approved' });
    expect(await threadsOf(content)).toEqual([]);
  });

  it.each([
    ['the access was removed', async (world: LinkWorld) => { await owner()('client_portal_accesses').where({ id: world.accessId }).update({ status: 'removed', generation: 2 }); }, 'A0100'],
    ['the client was archived', async (world: LinkWorld) => { await w.archiveClient(world.clientId); }, 'A0100'],
    ['the agency is read only', async () => {
      await owner()('agencies').where({ id: ids.agencyA }).update({
        plan: 'trial', trial_ends_at: owner().raw("now() - interval '1 minute'"), trial_owner_email_key: owner().raw('coalesce(trial_owner_email_key, id::text)')
      });
    }, 'A0090']
  ] as const)('stops working when %s, even for an approved content of a later day (%s)', async (_label, apply, code) => {
    const own = await linkChannel();
    const content = await own.seed('approved', await a.day(3));
    const before = await rowOf(content);
    try {
      await apply(own.world);
      await expect(own.ask(content)).rejects.toMatchObject({ code });
    } finally {
      if (code === 'A0090') await owner()('agencies').where({ id: ids.agencyA }).update({ plan: 'isenta', trial_ends_at: null, trial_owner_email_key: null, status: 'active' });
    }
    expect(await rowOf(content)).toEqual(before);
    expect(await threadsOf(content)).toEqual([]);
  });
});

// ---- the day of São Paulo, at fixed instants ---------------------------------------------------------------------------------------
// The planned day is far from today, so a function that reads a clock or a zone of its own disagrees with the pinned one and goes red.

describe('the portal: the edges of the day, at fixed instants of São Paulo', () => {
  const c = portalChannel();
  const PLANNED = '2031-03-14';

  it.each([
    ['two days before', '2031-03-12T10:00:00-03:00', true],
    ['the eve at noon', '2031-03-13T12:00:00-03:00', true],
    ['the eve at 23:59 of São Paulo', '2031-03-13T23:59:30-03:00', true],
    ['the eve at 22:30 of São Paulo, when UTC is already on the planned day', '2031-03-14T01:30:00Z', true],
    ['the eve at 23:59 of São Paulo, written in UTC', '2031-03-14T02:59:30Z', true],
    ['midnight of the planned day', '2031-03-14T00:00:00-03:00', false],
    ['midnight of the planned day, written in UTC', '2031-03-14T03:00:00Z', false],
    ['00:30 of the planned day in São Paulo', '2031-03-14T03:30:00Z', false],
    ['noon of the planned day', '2031-03-14T12:00:00-03:00', false],
    ['23:59 of the planned day', '2031-03-14T23:59:00-03:00', false],
    ['the day after the planned day', '2031-03-15T09:00:00-03:00', false]
  ] as const)('an approved content planned for 2031-03-14 at %s (%s): accepted %s', async (_label, instant, accepted) => {
    const content = await c.seed('approved', PLANNED);

    const result = await c.askAt(instant, content);

    if (accepted) {
      expect(result).toMatchObject({ ok: true, read: { row: { status: 'adjusting', ...NOT_CLEARED } } });
    } else {
      expect(result).toEqual({ ok: false, code: 'A0062' });
    }
  });

  it('asks the day of the instant at which it decides, not the one at which the transaction began', async () => {
    const content = await c.seed('approved', PLANNED);

    const result = await c.askAt('2031-03-13T12:00:00-03:00', content);

    expect(result).toMatchObject({ ok: true, read: { later: true } });
  });

  it('does not let the day of a content awaiting approval matter, at any instant', async () => {
    for (const instant of ['2031-03-13T23:59:30-03:00', '2031-03-14T00:00:00-03:00', '2031-03-20T12:00:00-03:00']) {
      const content = await c.seed('awaiting_approval', PLANNED);
      expect(await c.askAt(instant, content), instant).toMatchObject({ ok: true, read: { row: { status: 'adjusting' } } });
    }
  });

  it('refuses a published content at every instant, even on the eve of the planned day', async () => {
    const content = await c.seed('published', PLANNED);

    expect(await c.askAt('2031-03-13T12:00:00-03:00', content)).toEqual({ ok: false, code: 'A0062' });
  });
});

// ---- one copy of the rule ---------------------------------------------------------------------------------------------------------------

describe('the rule lives once, and only the portal asks it', () => {
  const sourceOf = async (signature: string): Promise<string> =>
    (await owner().raw<{ rows: Array<{ source: string }> }>('select pg_catalog.pg_get_functiondef(?::regprocedure) as source', [signature])).rows[0]!.source;

  it('the portal asks the helper with the state and the day read from the locked row, and keeps no copy of the rule', async () => {
    const source = await sourceOf('app_private.request_content_changes(uuid, integer, text)');
    expect(source).toContain('app_private.content_accepts_changes_request(v_status, v_publish_on)');
    expect(source.split('content_accepts_changes_request')).toHaveLength(2);
    expect(source).not.toMatch(/v_status\s*(<>|=|!=)\s*'(awaiting_approval|approved)'/);
    expect(source).not.toMatch(/publish_on\s*(>|<|>=|<=)/);
    expect(source).not.toMatch(/sao_paulo_date|clock_timestamp|now\(\)|current_date|time zone/i);
    expect(source).toMatch(/select content\.status, content\.revision, content\.publish_on into v_status, v_revision, v_publish_on[\s\S]*?for update;/);
  });

  it('checks the membership of the person again after the lock of the content', async () => {
    const source = await sourceOf('app_private.request_content_changes(uuid, integer, text)');
    expect(source).toMatch(/for update;\s*-- [^\n]*\n\s*if not app_private\.is_client_member\(v_client_id\) then\s*raise exception using errcode = 'A0060'/);
  });

  it('the link of the e-mail does not ask the helper and keeps its old test: awaiting approval, and nothing else, on any day', async () => {
    const source = await sourceOf('app_private.request_changes_by_portal_approval(text, uuid, integer, text)');
    expect(source).not.toContain('content_accepts_changes_request');
    expect(source).toContain("if v_status <> 'awaiting_approval' then");
    expect(source).not.toMatch(/publish_on|sao_paulo_date|clock_timestamp|now\(\)|current_date|time zone/i);
  });

  it('has no other caller of the helper in the schema: the portal is the only one', async () => {
    const { rows } = await owner().raw<{ rows: Array<{ proname: string }> }>(
      `select proc.proname from pg_catalog.pg_proc proc where proc.prosrc like '%content_accepts_changes_request%' and proc.proname <> 'content_accepts_changes_request'`
    );
    expect(rows).toEqual([{ proname: 'request_content_changes' }]);
  });

  it('keeps the helper closed: it asks the day from the one function of the zone, with the clock of the decision, and names no zone of its own', async () => {
    const source = await sourceOf('app_private.content_accepts_changes_request(text, date)');
    expect(source).toContain('app_private.sao_paulo_date(pg_catalog.clock_timestamp())');
    expect(source).toContain("p_status = 'awaiting_approval'");
    expect(source).toContain("p_status = 'approved' and p_publish_on > ");
    expect(source).not.toMatch(/at time zone|current_date|localtimestamp|America\/Sao_Paulo/i);
  });
});
