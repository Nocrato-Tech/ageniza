import { AGENCY_SEARCH_GROUP_LIMIT, type AgencySearchContent, type AgencySearchFile } from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';

export type SearchTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/** The groups the person may read: a group that is `false` is not queried at all, so neither its time nor its errors say anything about it. */
export interface SearchAccess {
  readonly clients: boolean;
  readonly contents: boolean;
  readonly files: boolean;
}

export interface SearchClientRow {
  readonly id: string;
  /** The agency of the row, lowercase as stored: the scope of the photo key is built from it, never from the (case-insensitive) URL. */
  readonly agency_id: string;
  readonly name: string;
  readonly photo_key: string | null;
  readonly instagram_handle: string | null;
  readonly archived: boolean;
}

export interface SearchContentRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly title: string;
  readonly format: AgencySearchContent['format'];
  readonly status: AgencySearchContent['status'];
  readonly publish_on: string;
  readonly publish_at_time: string | null;
  readonly today: string;
  readonly local_time: string;
}

export interface SearchFileRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly folder_id: string;
  readonly file_name: string;
  readonly category: AgencySearchFile['category'];
  readonly thumbnail_asset_id: string | null;
}

export interface SearchRows {
  readonly clients: readonly SearchClientRow[];
  readonly contents: readonly SearchContentRow[];
  readonly files: readonly SearchFileRow[];
}

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** `%`, `_` and the escape character itself are text in what was typed; the `escape` clause below names the backslash. */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

interface Patterns {
  readonly contains: string;
  readonly prefix: string;
  readonly handle: string;
}

/**
 * The patterns of one term. The handle is stored without the `@`, so a leading `@` the person typed means the handle and is dropped
 * for that clause only, as the carteira does; a lone `@` stays, since dropping it would match every client that has a handle.
 */
const patternsOf = (term: string): Patterns => {
  const handleTerm = term.startsWith('@') && term.length > 1 ? term.slice(1) : term;
  return {
    contains: `%${escapeLikePattern(term)}%`,
    prefix: `${escapeLikePattern(term)}%`,
    handle: `%${escapeLikePattern(handleTerm)}%`
  };
};

// The three patterns are folded once, by the one expression the carteira and the Equipe fold their columns with, so a column and a term never diverge.
const TERM_CTE = `
  term as (
    select ${foldTextSql('?')} as contains, ${foldTextSql('?')} as prefix, ${foldTextSql('?')} as handle
  )
`;

const matches = (column: string, pattern: string): string => `${foldTextSql(column)} like ${pattern} escape '\\'`;

/**
 * The name nearest the start comes first (a prefix before a plain substring), then the folded name, and the id breaks the tie, so the same
 * term always gives the same six in the same order. `collate "C"` makes the order the same in every database.
 */
const ranking = (column: string, idColumn: string): string =>
  `(${matches(column, 'term.prefix')}) desc, ${foldTextSql(column)} collate "C" asc, ${idColumn} asc`;

/**
 * Clients by name, legal name and handle. The agency of the route is in the WHERE: `clients_select` shows every agency the person
 * belongs to, and a person who is also in the portal of a client elsewhere reads that client too, so the policy alone does not keep
 * another agency out.
 */
const searchClients = async (transaction: SearchTransaction, agencyId: string, patterns: Patterns): Promise<readonly SearchClientRow[]> => {
  const result = await raw<RawRows<SearchClientRow>>(transaction, `
    with ${TERM_CTE}
    select client.id, client.agency_id, client.name, client.photo_key, client.instagram_handle, (client.status = 'archived') as archived
    from public.clients as client
    cross join term
    where client.agency_id = ?::uuid
      and (
        ${matches('client.name', 'term.contains')}
        or ${matches('client.legal_name', 'term.contains')}
        or ${matches('client.instagram_handle', 'term.handle')}
      )
    order by ${ranking('client.name', 'client.id')}
    limit ?
  `, [patterns.contains, patterns.prefix, patterns.handle, agencyId, AGENCY_SEARCH_GROUP_LIMIT]);
  return result.rows;
};

/**
 * Contents by title, with the client's name, cancelled ones included. The agency is the client's: `contents` carries none of its own.
 * The same statement reads the day and the time of São Paulo at one instant (`now` is a test's, else the database's), so the two derived
 * states are decided by the one definition in `packages/contracts` over a clock that agrees with itself.
 */
const searchContents = async (
  transaction: SearchTransaction,
  agencyId: string,
  patterns: Patterns,
  now: Date | undefined
): Promise<readonly SearchContentRow[]> => {
  const result = await raw<RawRows<SearchContentRow>>(transaction, `
    with ${TERM_CTE},
    clock_instant as (
      select coalesce(?::timestamptz, pg_catalog.now()) as now_at
    ),
    clock as (
      select app_private.sao_paulo_date(clock_instant.now_at) as today,
        to_char(clock_instant.now_at - (app_private.sao_paulo_end_of_day(app_private.sao_paulo_date(clock_instant.now_at) - 1) + interval '1 minute'), 'HH24:MI:SS') as local_time
      from clock_instant
    )
    select content.id, content.client_id, client.name as client_name, content.title, content.format, content.status,
      content.publish_on::text as publish_on, to_char(content.publish_at_time, 'HH24:MI') as publish_at_time,
      clock.today::text as today, clock.local_time
    from public.contents as content
    join public.clients as client on client.id = content.client_id
    cross join term
    cross join clock
    where client.agency_id = ?::uuid
      and ${matches('content.title', 'term.contains')}
    order by ${ranking('content.title', 'content.id')}
    limit ?
  `, [patterns.contains, patterns.prefix, patterns.handle, now?.toISOString() ?? null, agencyId, AGENCY_SEARCH_GROUP_LIMIT]);
  return result.rows;
};

/**
 * Files by name: the confirmed ones that were not removed (an upload still in flight, a refused one and a removed one are not files the
 * person has), and a file with no name, from before the name was kept, matches nothing since `like` over null is not true. The picture of
 * a file is itself for an image, a logo and a video whose thumbnail the worker made; a PDF and an audio have none. The agency is on the
 * asset itself as well as on the client: through the client alone the planner may scan the assets of every agency and run the policy on
 * each, so the cost of one agency would follow the volume of the others.
 */
const searchFiles = async (transaction: SearchTransaction, agencyId: string, patterns: Patterns): Promise<readonly SearchFileRow[]> => {
  const result = await raw<RawRows<SearchFileRow>>(transaction, `
    with ${TERM_CTE}
    select asset.id, asset.client_id, client.name as client_name, asset.folder_id, asset.file_name, asset.category,
      case
        when asset.category in ('image', 'logo') or (asset.category = 'video' and asset.thumbnail_object_key is not null) then asset.id
        else null
      end as thumbnail_asset_id
    from public.media_assets as asset
    join public.clients as client on client.id = asset.client_id
    cross join term
    where client.agency_id = ?::uuid
      and asset.agency_id = ?::uuid
      and asset.status = 'confirmed'
      and asset.removed_at is null
      and asset.folder_id is not null
      and ${matches('asset.file_name', 'term.contains')}
    order by ${ranking('asset.file_name', 'asset.id')}
    limit ?
  `, [patterns.contains, patterns.prefix, patterns.handle, agencyId, agencyId, AGENCY_SEARCH_GROUP_LIMIT]);
  return result.rows;
};

/**
 * The three groups, each only when the person may read it. A group they may not read is never queried: it is `[]` without a statement,
 * so the answer of a person who cannot read contents is the one of a person who can and found nothing, in the same time.
 */
export const searchAgency = async (
  transaction: SearchTransaction,
  input: { readonly agencyId: string; readonly term: string; readonly access: SearchAccess; readonly now: Date | undefined }
): Promise<SearchRows> => {
  const patterns = patternsOf(input.term);
  const clients = input.access.clients ? await searchClients(transaction, input.agencyId, patterns) : [];
  const contents = input.access.contents ? await searchContents(transaction, input.agencyId, patterns, input.now) : [];
  const files = input.access.files ? await searchFiles(transaction, input.agencyId, patterns) : [];
  return { clients, contents, files };
};
