import { AWAITING_CLIENT_MAX_CONTENTS, type AwaitingClientContent, type AwaitingClientResponse } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { APPROVAL_JOIN, type ContentTransaction } from './service.js';

interface AwaitingRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly title: string;
  readonly format: AwaitingClientContent['format'];
  readonly publish_on: string;
  readonly approval_sent_at: Date | null;
  readonly approval_due_on: string | null;
  readonly days_waiting: number | null;
  readonly days_to_due: number | null;
}

/**
 * What waits for the client, the most urgent first: the earliest deadline (a deadline that passed comes before one that did not), then the
 * content with no deadline that has waited longest. The ceiling is applied to this order, so the cut leaves out the least urgent. Read
 * under the policy of `contents` (the one of the calendar and the feed: `conteudo.visualizar` in the agency of the client), so a person
 * sees exactly the contents they see there. A client that was archived is no longer asked for anything and is left out.
 *
 * Both counts are days of America/Sao_Paulo, taken from the same instant (`now`, or the database's clock): the day of the deadline minus
 * today, and today minus the day the round was sent. `daysWaiting` never goes below zero.
 */
export const listAwaitingClient = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly now: Date | undefined }
): Promise<AwaitingClientResponse> => {
  const result = await raw<{ readonly rows: readonly AwaitingRow[] }>(transaction, `
    select content.id, client.id as client_id, client.name as client_name, content.title, content.format,
      content.publish_on::text as publish_on, approval.sent_at as approval_sent_at, approval.due_on::text as approval_due_on,
      case when approval.sent_at is null then null
        else greatest(0, today.day - app_private.sao_paulo_date(approval.sent_at)) end as days_waiting,
      case when approval.due_on is null then null else approval.due_on - today.day end as days_to_due
    from public.contents content
    join public.clients client on client.id = content.client_id
    cross join (select app_private.sao_paulo_date(coalesce(?::timestamptz, pg_catalog.now())) as day) today
    ${APPROVAL_JOIN}
    where client.agency_id = ?::uuid and client.status = 'active' and content.status = 'awaiting_approval'
    order by approval.due_on asc nulls last, approval.sent_at asc nulls last, content.publish_on, content.id
    limit ?
  `, [input.now?.toISOString() ?? null, input.agencyId, AWAITING_CLIENT_MAX_CONTENTS + 1]);

  const rows = result.rows.slice(0, AWAITING_CLIENT_MAX_CONTENTS);
  const groups = new Map<string, AwaitingClientResponse['data'][number]>();
  for (const row of rows) {
    const group = groups.get(row.client_id) ?? { clientId: row.client_id, clientName: row.client_name, contents: [] };
    groups.set(row.client_id, group);
    group.contents.push({
      id: row.id,
      title: row.title,
      format: row.format,
      publishOn: row.publish_on,
      sentAt: row.approval_sent_at === null ? null : new Date(row.approval_sent_at).toISOString(),
      dueOn: row.approval_due_on,
      daysWaiting: row.days_waiting === null ? null : Number(row.days_waiting),
      daysToDue: row.days_to_due === null ? null : Number(row.days_to_due)
    });
  }
  return { data: [...groups.values()], meta: { truncated: result.rows.length > AWAITING_CLIENT_MAX_CONTENTS } };
};
