import type { Knex } from 'knex';

import { databaseErrorCode } from '../../src/index.js';

// `now()` cannot be pinned, but the day is a function of the clock: inside a transaction that is rolled back, `app_private.sao_paulo_date`
// is replaced by a stand-in that answers the day of a FIXED instant (moved by the time the transaction has run, so a function that asks about
// `now() + 1 day` gets the next day) and records every instant it was asked about. What a function does with the day it is told is then a fact
// of its own behaviour, and the instants are far from the run of the test, so a function that reads a clock or a zone of its own disagrees.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|-03:00)$/;

export const pinnedStandIn = (instant: string): string => {
  if (!INSTANT.test(instant)) throw new Error(`Not an instant: ${instant}`);
  return `
    create or replace function app_private.sao_paulo_date(p_instant timestamptz) returns date
    language plpgsql volatile set search_path = '' as $stand_in$
    begin
      perform pg_catalog.set_config('test.asked_instants', coalesce(pg_catalog.current_setting('test.asked_instants', true), '') || p_instant::pg_catalog.text || ';', true);
      return ((timestamptz '${instant}' + (p_instant - pg_catalog.now())) at time zone 'America/Sao_Paulo')::pg_catalog.date;
    end
    $stand_in$
  `;
};

const ASKED = `
  unnest(pg_catalog.string_to_array(coalesce(pg_catalog.current_setting('test.asked_instants', true), ''), ';')) as asked(value)
  where asked.value <> ''
`;

/** Whether the stand-in was asked about an instant later than the start of the transaction: the clock of the decision, not `now()`. */
export const askedLaterThanTheStart = async (transaction: Knex.Transaction): Promise<boolean> =>
  (await transaction.raw<{ rows: Array<{ later: boolean }> }>(
    `select coalesce(pg_catalog.bool_or(asked.value::pg_catalog.timestamptz > pg_catalog.now()), false) as later from ${ASKED}`
  )).rows[0]!.later;

/** Whether the stand-in was asked about an instant of the database clock at or after `instant`. */
export const askedAtOrAfter = async (transaction: Knex.Transaction, instant: string): Promise<boolean> =>
  (await transaction.raw<{ rows: Array<{ later: boolean }> }>(
    `select coalesce(pg_catalog.bool_or(asked.value::pg_catalog.timestamptz >= ?::pg_catalog.timestamptz), false) as later from ${ASKED}`, [instant]
  )).rows[0]!.later;

export type AtInstant<TRead> = { readonly ok: true; readonly read: TRead } | { readonly ok: false; readonly code: string | undefined };

/**
 * One call as `ageniza_app` (with `actor` bound, or no one), in a transaction of the owner that is rolled back, with the day of São Paulo
 * pinned at `instant`. `readAfter` reads, as the owner, what the call left in the same transaction.
 */
export const callAtInstant = async <TRead>(
  owner: Knex,
  instant: string,
  actor: string | null,
  call: (transaction: Knex.Transaction) => Promise<unknown>,
  readAfter: (transaction: Knex.Transaction) => Promise<TRead>
): Promise<AtInstant<TRead>> => {
  const transaction = await owner.transaction();
  try {
    await transaction.raw('set local role ageniza_app');
    if (actor !== null) await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
    await transaction.raw('reset role');
    await transaction.raw(pinnedStandIn(instant));
    await transaction.raw('set local role ageniza_app');
    try {
      await call(transaction);
    } catch (error) {
      return { ok: false, code: databaseErrorCode(error) };
    }
    await transaction.raw('reset role');
    return { ok: true, read: await readAfter(transaction) };
  } finally {
    await transaction.rollback();
  }
};
