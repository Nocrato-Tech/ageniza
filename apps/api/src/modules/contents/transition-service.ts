import { raw } from '@ageniza/database';

import type { ContentTransaction } from './service.js';

/*
 * The six functions of the database that move a content (migrations 20261007001200, 20261007001500). Each one checks the
 * caller and the permission before it takes the row, takes the client FOR SHARE before the content (so it waits for an
 * archive in course and reads the client after the wait), and answers its refusals by `A00xx` codes. The route decides
 * nothing the function decides: it passes the ids and what the body carries.
 */

type RoundInput = {
  /** The deadline as an instant with its offset. */
  readonly dueAt?: string | undefined;
  /** The deadline as a day: the end of that day in São Paulo, by the one function of the database that turns a day into an instant. */
  readonly dueOn?: string | undefined;
  readonly note?: string | undefined;
};

// The contract holds the two apart; the database keeps the one instant and checks it (from now to 90 days ahead) with the note, and writes the round.
const DEADLINE_SQL = 'coalesce(?::timestamptz, app_private.sao_paulo_end_of_day(?::date))';

export const submitContent = async (transaction: ContentTransaction, contentId: string, round: RoundInput = {}): Promise<void> => {
  await raw(
    transaction,
    `select app_private.submit_content(?::uuid, ${DEADLINE_SQL}, ?::text)`,
    [contentId, round.dueAt ?? null, round.dueOn ?? null, round.note ?? null]
  );
};

/** All or nothing, of one client, under one batch id the function returns; the ids are UUIDs the contract already checked. */
export const submitContents = async (
  transaction: ContentTransaction,
  input: RoundInput & { readonly contentIds: readonly string[] }
): Promise<string> => {
  const result = await raw<{ rows: Array<{ batch_id: string }> }>(
    transaction,
    `select app_private.submit_contents(?::uuid[], ${DEADLINE_SQL}, ?::text) as batch_id`,
    [`{${input.contentIds.join(',')}}`, input.dueAt ?? null, input.dueOn ?? null, input.note ?? null]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The batch send returned no batch.');
  return row.batch_id;
};

export const approveContentByAgency = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly revision: number; readonly reason: string }
): Promise<void> => {
  await raw(transaction, 'select app_private.approve_content_by_agency(?::uuid, ?::integer, ?)', [input.contentId, input.revision, input.reason]);
};

export const publishContent = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly publishedOn: string }
): Promise<void> => {
  await raw(transaction, 'select app_private.publish_content(?::uuid, ?::date)', [input.contentId, input.publishedOn]);
};

export const unpublishContent = async (transaction: ContentTransaction, contentId: string): Promise<void> => {
  await raw(transaction, 'select app_private.unpublish_content(?::uuid)', [contentId]);
};

export const cancelContent = async (transaction: ContentTransaction, contentId: string): Promise<void> => {
  await raw(transaction, 'select app_private.cancel_content(?::uuid)', [contentId]);
};

/** `publishOn` absent keeps the day the content had; the function takes `null` for that. */
export const rescheduleContent = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly publishOn: string | undefined }
): Promise<void> => {
  await raw(transaction, 'select app_private.reschedule_content(?::uuid, ?::date)', [input.contentId, input.publishOn ?? null]);
};

/**
 * The day of America/Sao_Paulo that `instant` falls in, by the one function the database converts days with. Without an instant it is
 * the database's own `now()`, the clock the trigger of the publication compares the day with; only a test passes one.
 */
export const saoPauloDay = async (transaction: ContentTransaction, instant?: Date): Promise<string> => {
  const result = instant === undefined
    ? await raw<{ rows: Array<{ day: string }> }>(transaction, 'select app_private.sao_paulo_date(pg_catalog.now())::text as day', [])
    : await raw<{ rows: Array<{ day: string }> }>(transaction, 'select app_private.sao_paulo_date(?::timestamptz)::text as day', [instant.toISOString()]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The day of São Paulo could not be read.');
  return row.day;
};

/** Whether a media of one of the contents has not finished uploading: a pending media is no media for a post the client will see. */
export const hasUnconfirmedMedia = async (transaction: ContentTransaction, contentIds: readonly string[]): Promise<boolean> => {
  const result = await raw<{ rows: Array<{ pending: boolean }> }>(transaction, `
    select exists (
      select 1
      from public.content_media item
      join public.media_assets asset on asset.id = item.asset_id
      where item.content_id = any(?::uuid[]) and asset.status <> 'confirmed'
    ) as pending
  `, [`{${contentIds.join(',')}}`]);
  return result.rows[0]?.pending === true;
};
