import {
  AWAITING_CLIENT_MAX_APPROVERS,
  AWAITING_CLIENT_MAX_CONTENTS,
  type AwaitingClientContent,
  type AwaitingClientResponse
} from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { canReadPortalPeople, loadPortalPeople } from './portal-people.js';
import { APPROVAL_JOIN, THUMBNAIL_JOIN, type ContentTransaction } from './service.js';

interface AwaitingRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly title: string;
  readonly format: AwaitingClientContent['format'];
  readonly publish_on: string;
  readonly thumbnail_asset_id: string | null;
  readonly approval_sent_at: Date | null;
  readonly approval_due_at: Date | null;
  readonly approval_due_on: string | null;
  readonly days_waiting: number | null;
  readonly days_to_due: number | null;
  readonly days_late: number | null;
}

/**
 * The names of who approves, per client, for whoever may read them (`cliente.convidar_usuario` in the agency); `undefined` for everyone
 * else, whose cabeçalho shows the client alone.
 */
const loadApprovers = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly clientIds: readonly string[] }
): Promise<ReadonlyMap<string, string[]> | undefined> => {
  if (!await canReadPortalPeople(transaction, input.agencyId)) return undefined;
  const people = await loadPortalPeople(transaction, { clientIds: input.clientIds, limit: AWAITING_CLIENT_MAX_APPROVERS });
  return new Map([...people].map(([clientId, entry]) => [clientId, entry.names]));
};

/**
 * What waits for the client, the one sent longest ago first (decision 2026-11-11): the content with no send date (sent before the rounds
 * existed) comes last, by its publication day, and the ceiling is applied to this order, so the cut leaves out the newest. The deadline of
 * the approval does not order the list: it is a second piece of information on each line. Read under the policy of `contents` (the one of
 * the calendar and the feed: `conteudo.visualizar` in the agency of the client), so a person sees exactly the contents they see there. A
 * client that was archived is no longer asked for anything and is left out.
 *
 * Every count is in days of America/Sao_Paulo, taken from the same instant (`now`, or the database's clock): today minus the day the round
 * was sent (`daysWaiting`, never below zero), the day of the deadline minus today (`daysToDue`), and today minus the publication day, only
 * when that day passed (`daysLate`).
 */
export const listAwaitingClient = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly now: Date | undefined }
): Promise<AwaitingClientResponse> => {
  const result = await raw<{ readonly rows: readonly AwaitingRow[] }>(transaction, `
    select content.id, client.id as client_id, client.name as client_name, content.title, content.format,
      content.publish_on::text as publish_on, thumbnail.asset_id as thumbnail_asset_id,
      approval.sent_at as approval_sent_at, approval.due_at as approval_due_at, approval.due_on::text as approval_due_on,
      case when approval.sent_at is null then null
        else greatest(0, today.day - app_private.sao_paulo_date(approval.sent_at)) end as days_waiting,
      case when approval.due_on is null then null else approval.due_on - today.day end as days_to_due,
      case when content.publish_on < today.day then today.day - content.publish_on else null end as days_late
    from public.contents content
    join public.clients client on client.id = content.client_id
    cross join (select app_private.sao_paulo_date(coalesce(?::timestamptz, pg_catalog.now())) as day) today
    ${THUMBNAIL_JOIN}
    ${APPROVAL_JOIN}
    where client.agency_id = ?::uuid and client.status = 'active' and content.status = 'awaiting_approval'
    order by approval.sent_at asc nulls last, content.publish_on, content.id
    limit ?
  `, [input.now?.toISOString() ?? null, input.agencyId, AWAITING_CLIENT_MAX_CONTENTS + 1]);

  const rows = result.rows.slice(0, AWAITING_CLIENT_MAX_CONTENTS);
  const clientIds = [...new Set(rows.map((row) => row.client_id))];
  const approvers = clientIds.length === 0 ? undefined : await loadApprovers(transaction, { agencyId: input.agencyId, clientIds });

  const groups = new Map<string, AwaitingClientResponse['data'][number]>();
  for (const row of rows) {
    const group = groups.get(row.client_id) ?? {
      clientId: row.client_id,
      clientName: row.client_name,
      approvers: approvers?.get(row.client_id) ?? null,
      contents: []
    };
    groups.set(row.client_id, group);
    group.contents.push({
      id: row.id,
      title: row.title,
      format: row.format,
      publishOn: row.publish_on,
      thumbnailAssetId: row.thumbnail_asset_id,
      sentAt: row.approval_sent_at === null ? null : new Date(row.approval_sent_at).toISOString(),
      dueAt: row.approval_due_at === null ? null : new Date(row.approval_due_at).toISOString(),
      dueOn: row.approval_due_on,
      daysWaiting: row.days_waiting === null ? null : Number(row.days_waiting),
      daysToDue: row.days_to_due === null ? null : Number(row.days_to_due),
      daysLate: row.days_late === null ? null : Number(row.days_late)
    });
  }
  return { data: [...groups.values()], meta: { truncated: result.rows.length > AWAITING_CLIENT_MAX_CONTENTS } };
};
