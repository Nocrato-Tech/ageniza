import {
  CONTENT_DEADLINE_OPEN_STATUSES,
  COLLABORATOR_OPEN_CONTENTS_MAX_CLIENTS,
  COLLABORATOR_OPEN_CONTENTS_NOW_LIMIT,
  type CollaboratorOpenContentsResponse
} from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';

type OpenContentsTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface OpenContentsRow {
  readonly total_clients: string | number;
  readonly total_contents: string | number;
  readonly total_awaiting: string | number;
  readonly client_id: string;
  readonly client_name: string;
  readonly contents: string | number;
  readonly awaiting: string | number;
  readonly content_id: string;
  readonly title: string;
  readonly state: CollaboratorOpenContentsResponse['data'][number]['now'][number]['state'];
}

/**
 * The agency's active membership a page is about, as the user it stands for: another agency's link, a
 * nonexistent one and a removed one are all "no row", so the route answers the same 404 for each.
 */
export const findActiveMembershipUser = async (
  transaction: OpenContentsTransaction,
  agencyId: string,
  membershipId: string
): Promise<string | undefined> => {
  const result = await raw<{ readonly rows: ReadonlyArray<{ readonly user_id: string }> }>(transaction, `
    select membership.user_id
    from public.agency_memberships as membership
    where membership.agency_id = ?::uuid
      and membership.id = ?::uuid
      and membership.status = 'active'
  `, [agencyId, membershipId]);
  return result.rows[0]?.user_id;
};

/**
 * What one person has open, per client (decision 2026-11-11): the contents whose `owner_user_id` is
 * the person's user, in the agency of the route, in an open state. Read under the policy of `contents`
 * and `clients` as the caller, so a content or a client the caller may not read is not counted. The
 * agency and the owner are repeated in the WHERE and do not rest on the policy alone: `contents_select`
 * shows every agency the caller belongs to, and the owner is not a policy at all.
 *
 * One statement, so the header and the cards come from the same snapshot. `summary` counts every
 * client; `data` is cut at the ceiling after the ordering by the client's folded name, with the client
 * id as the tie-break. `now` is the content closest to going live first, by the day, the hour (a
 * content without an hour comes after the ones with it that day) and the id.
 */
export const listOpenContents = async (
  transaction: OpenContentsTransaction,
  input: { readonly agencyId: string; readonly userId: string }
): Promise<CollaboratorOpenContentsResponse> => {
  const result = await raw<{ readonly rows: readonly OpenContentsRow[] }>(transaction, `
    with mine as (
      select content.id, content.title, content.status, content.publish_on, content.publish_at_time,
        client.id as client_id, client.name as client_name
      from public.contents as content
      join public.clients as client on client.id = content.client_id
      where client.agency_id = ?::uuid
        and content.owner_user_id = ?::uuid
        and content.status in (${CONTENT_DEADLINE_OPEN_STATUSES.map(() => '?').join(', ')})
    ),
    per_client as (
      select client_id, client_name, count(*) as contents,
        count(*) filter (where status = 'awaiting_approval') as awaiting
      from mine
      group by client_id, client_name
    ),
    shown as (
      select client_id, client_name, contents, awaiting
      from per_client
      order by ${foldTextSql('client_name')} collate "C" asc, client_id asc
      limit ?
    ),
    nearest as (
      select id, client_id, title, status,
        row_number() over (partition by client_id order by publish_on asc, publish_at_time asc, id asc) as position
      from mine
      where client_id in (select client_id from shown)
    )
    select
      (select count(*) from per_client) as total_clients,
      (select coalesce(sum(contents), 0) from per_client) as total_contents,
      (select coalesce(sum(awaiting), 0) from per_client) as total_awaiting,
      shown.client_id, shown.client_name, shown.contents, shown.awaiting,
      nearest.id as content_id, nearest.title, nearest.status as state
    from shown
    join nearest on nearest.client_id = shown.client_id and nearest.position <= ?
    order by ${foldTextSql('shown.client_name')} collate "C" asc, shown.client_id asc, nearest.position asc
  `, [
    input.agencyId,
    input.userId,
    ...CONTENT_DEADLINE_OPEN_STATUSES,
    COLLABORATOR_OPEN_CONTENTS_MAX_CLIENTS,
    COLLABORATOR_OPEN_CONTENTS_NOW_LIMIT
  ]);

  const first = result.rows[0];
  if (first === undefined) return { summary: { clients: 0, contents: 0, awaiting: 0 }, data: [] };

  const data: CollaboratorOpenContentsResponse['data'] = [];
  for (const row of result.rows) {
    let entry = data[data.length - 1];
    if (entry === undefined || entry.client.id !== row.client_id) {
      entry = { client: { id: row.client_id, name: row.client_name }, contents: Number(row.contents), awaiting: Number(row.awaiting), now: [] };
      data.push(entry);
    }
    entry.now.push({ contentId: row.content_id, title: row.title, state: row.state });
  }
  return {
    summary: { clients: Number(first.total_clients), contents: Number(first.total_contents), awaiting: Number(first.total_awaiting) },
    data
  };
};
