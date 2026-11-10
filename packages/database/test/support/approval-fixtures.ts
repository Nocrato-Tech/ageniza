import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import type { ContentWorld } from './content-world.js';

// What the tests of the approval rounds and of the reminders share: a content that can be sent, the state of the rounds and of the queue
// as the owner reads them, the day of São Paulo as the database says it, and the way a person of the agency sends. The owner prepares and
// reads; every attack runs as `ageniza_app`.
export interface ApprovalFixtures {
  owner(): Knex;
  extraClients: string[];
  /** A client of agency A with the given people on its portal (an access each); it is removed by `cleanUp`. */
  freshClient(people?: readonly string[]): Promise<string>;
  /** A reels with one confirmed video: it can be sent. */
  readyContent(clientId?: string, status?: 'in_production' | 'approved' | 'adjusting' | 'awaiting_approval'): Promise<string>;
  /** The day of São Paulo `offset` days from now, as the database computes it. */
  day(offset?: number): Promise<string>;
  sql<T = string>(query: string, bindings?: readonly unknown[]): Promise<T>;
  submit(user: string, contentId: string, dueOn?: string | null, note?: string | null): Promise<unknown>;
  submitBatch(user: string, contentIds: readonly string[], dueOn?: string | null, note?: string | null): Promise<string>;
  roundsOf(contentId: string): Promise<Array<Record<string, unknown>>>;
  queueOf(contentId: string): Promise<Array<Record<string, unknown>>>;
  /** Moves a waiting content to "in adjustment" the way the portal does, with a request for changes by `user`. */
  requestChanges(user: string, contentId: string): Promise<void>;
  /**
   * The deadline and the day of the portal are read from the database clock, so a suite starts only when the minutes around São Paulo
   * midnight are not ahead of it: the day it computed would not be the day the function sees.
   */
  waitForQuietClock(): Promise<void>;
  cleanUp(): Promise<void>;
}

export const QUIET_SECONDS = 60;

/** How long a suite waits before it starts: the deadline of a round is a day of São Paulo, and the database reads its own clock. */
export const secondsUntilClockIsQuiet = (secondsSinceMidnight: number, secondsToMidnight: number): number => {
  if (secondsSinceMidnight < QUIET_SECONDS) return QUIET_SECONDS - secondsSinceMidnight;
  if (secondsToMidnight < QUIET_SECONDS) return secondsToMidnight + QUIET_SECONDS;
  return 0;
};

export const createApprovalFixtures = (w: ContentWorld): ApprovalFixtures => {
  const { ids } = w;
  const extraClients: string[] = [];
  const owner = (): Knex => w.getOwner().knex;

  const sql = async <T = string>(query: string, bindings: readonly unknown[] = []): Promise<T> => {
    const { rows } = await owner().raw<{ rows: Array<{ value: T }> }>(query, [...bindings]);
    return rows[0]!.value;
  };

  return {
    owner,
    extraClients,
    freshClient: async (people = [ids.portalA1, ids.portalA1Second]) => {
      const id = randomUUID();
      extraClients.push(id);
      await owner()('clients').insert({ id, agency_id: ids.agencyA, name: `Rodada ${id}` });
      if (people.length > 0) await owner()('client_memberships').insert(people.map((user) => ({ client_id: id, user_id: user })));
      return id;
    },
    readyContent: async (clientId = ids.clientA1, status = 'in_production') => {
      const folder = await w.folderOf(clientId);
      const id = await w.seedContent(clientId, { status });
      await w.attach(id, [await w.seedAsset(clientId, folder, { category: 'video' })]);
      return id;
    },
    day: (offset = 0) => sql('select (app_private.sao_paulo_date(pg_catalog.now()) + ?::integer)::text as value', [offset]),
    sql,
    submit: (user, contentId, dueOn, note) =>
      w.asUser(user, (t) => t.raw('select app_private.submit_content(?::uuid, ?::date, ?::text)', [contentId, dueOn ?? null, note ?? null])),
    submitBatch: (user, contentIds, dueOn, note) =>
      w.asUser(user, async (t) =>
        (await t.raw<{ rows: Array<{ batch_id: string }> }>(
          'select app_private.submit_contents(?::uuid[], ?::date, ?::text) as batch_id', [[...contentIds], dueOn ?? null, note ?? null]
        )).rows[0]!.batch_id
      ),
    // `due_on` as text: the driver reads a DATE as a JS Date in the zone of the machine, which is not the day of the database.
    roundsOf: async (contentId) =>
      (await owner()('content_approval_rounds').where({ content_id: contentId }).orderBy('sequence').select(
        'id', 'batch_id', 'client_id', 'content_id', 'sequence', 'note', 'sent_by', 'sent_at', 'reminded_due_soon_at', 'reminded_overdue_at',
        owner().raw('due_on::text as due_on')
      )) as Array<Record<string, unknown>>,
    queueOf: async (contentId) => (await owner()('notification_queue').where({ content_id: contentId })) as Array<Record<string, unknown>>,
    requestChanges: async (user, contentId) => {
      const revision = (await w.contentRow(contentId)).revision as number;
      await w.asUser(user, (t) => t.raw('select app_private.request_content_changes(?::uuid, ?::integer, ?::text)', [contentId, revision, 'Ajustar a legenda']));
    },
    waitForQuietClock: async () => {
      const row = (await owner().raw<{ rows: Array<{ since: number; until: number }> }>(`
        select extract(epoch from now() - app_private.sao_paulo_date(now())::timestamp at time zone 'America/Sao_Paulo')::float8 as since,
               extract(epoch from (app_private.sao_paulo_date(now()) + 1)::timestamp at time zone 'America/Sao_Paulo' - now())::float8 as until
      `)).rows[0]!;
      const wait = secondsUntilClockIsQuiet(row.since, row.until);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    },
    cleanUp: async () => {
      const knex = owner();
      await knex('client_portal_approval_links').whereIn('client_id', extraClients).delete();
      await knex('notification_queue').whereIn('client_id', extraClients).delete();
      for (const table of ['client_thread_comments', 'client_threads', 'content_tasks', 'content_media', 'contents', 'media_assets', 'media_folders', 'client_memberships']) {
        await knex(table).whereIn('client_id', extraClients).delete();
      }
      await knex('audit.events').whereIn('target_id', extraClients).delete();
      await knex('clients').whereIn('id', extraClients).delete();
    }
  };
};
