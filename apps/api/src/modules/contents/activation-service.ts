import type { ContentActivationResponse } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { canReadPortalPeople, loadPortalPeople } from './portal-people.js';
import { APPROVER_NAME, approverJoin, type ContentTransaction } from './service.js';

type Steps = ContentActivationResponse['data']['steps'];

interface RawRows<TRow> {
  readonly rows: readonly TRow[];
}

const instant = (value: Date): string => new Date(value).toISOString();

/**
 * Four yes/no facts about the agency's contents, each an `exists` that stops at the first row the policy lets through.
 * "Sent" is a content that left production for the client (or was approved, which needs it); "approved by the client" mirrors
 * how the detail names the approver: an approver that is not an approval outside the platform (which always carries a reason).
 */
const loadFacts = async (transaction: ContentTransaction, agencyId: string): Promise<Omit<ContentActivationResponse['data'], 'steps'>> => {
  const result = await raw<{ readonly rows: ReadonlyArray<{ has_content: boolean; sent: boolean; approved: boolean; published: boolean }> }>(transaction, `
    with agency_contents as (
      select content.status, content.approved_at, content.approved_by, content.approved_by_portal_access_id, content.approved_by_agency_reason
      from public.contents content
      join public.clients client on client.id = content.client_id
      where client.agency_id = ?::uuid
    )
    select
      exists (select 1 from agency_contents) as has_content,
      exists (select 1 from agency_contents where status in ('awaiting_approval', 'adjusting', 'approved', 'published') or approved_at is not null) as sent,
      exists (
        select 1 from agency_contents
        where approved_at is not null and approved_by_agency_reason is null
          and (approved_by is not null or approved_by_portal_access_id is not null)
      ) as approved,
      exists (select 1 from agency_contents where status = 'published') as published
  `, [agencyId]);
  const row = result.rows[0];
  return { hasContent: row?.has_content === true, sentForApproval: row?.sent === true, approvedByClient: row?.approved === true, published: row?.published === true };
};

/**
 * The date and the name of each step already taken (decision 2026-11-11), the earliest of the agency's, read under the same policies as the
 * facts. A step is `null` when it was not taken or when nothing dates it: a content sent before the rounds existed has no send date.
 *
 * The send is named for the first active person of the client's portal who has entered it ("e mais N" for the others), read only with
 * `cliente.convidar_usuario`; without that permission, or without a known person, it carries the name of the client and no others. The
 * approval is named for who approved, as the detail of the content names them, and for the client when that account is no longer known.
 */
const loadSteps = async (transaction: ContentTransaction, agencyId: string): Promise<Steps> => {
  const client = await raw<RawRows<{ name: string; created_at: Date }>>(transaction, `
    select client.name, client.created_at
    from public.clients client
    where client.agency_id = ?::uuid
    order by client.created_at, client.id
    limit 1
  `, [agencyId]);

  const content = await raw<RawRows<{ title: string; created_at: Date }>>(transaction, `
    select content.title, content.created_at
    from public.contents content
    join public.clients client on client.id = content.client_id
    where client.agency_id = ?::uuid
    order by content.created_at, content.id
    limit 1
  `, [agencyId]);

  const sent = await raw<RawRows<{ sent_at: Date; client_id: string; client_name: string }>>(transaction, `
    select round.sent_at, client.id as client_id, client.name as client_name
    from public.content_approval_rounds round
    join public.clients client on client.id = round.client_id
    where client.agency_id = ?::uuid
    order by round.sent_at, round.content_id, round.sequence
    limit 1
  `, [agencyId]);

  const approved = await raw<RawRows<{ approved_at: Date; client_name: string; approver_name: string | null }>>(transaction, `
    select content.approved_at, client.name as client_name, ${APPROVER_NAME} as approver_name
    from public.contents content
    join public.clients client on client.id = content.client_id
    ${approverJoin('client.agency_id')}
    where client.agency_id = ?::uuid and content.approved_at is not null and content.approved_by_agency_reason is null
      and (content.approved_by is not null or content.approved_by_portal_access_id is not null)
    order by content.approved_at, content.id
    limit 1
  `, [agencyId]);

  const firstSent = sent.rows[0];
  let sentStep: Steps['firstSent'] = null;
  if (firstSent !== undefined) {
    // One name needs only the first person; "e mais N" needs all the others counted, so the first is read and the total comes with it.
    const people = await canReadPortalPeople(transaction, agencyId)
      ? (await loadPortalPeople(transaction, { clientIds: [firstSent.client_id], limit: 1 })).get(firstSent.client_id)
      : undefined;
    const first = people?.names[0];
    sentStep = {
      at: instant(firstSent.sent_at),
      name: first ?? firstSent.client_name,
      others: first === undefined || people === undefined ? 0 : people.total - 1
    };
  }

  const firstApproved = approved.rows[0];
  return {
    firstClient: client.rows[0] === undefined ? null : { at: instant(client.rows[0].created_at), name: client.rows[0].name },
    firstContent: content.rows[0] === undefined ? null : { at: instant(content.rows[0].created_at), name: content.rows[0].title },
    firstSent: sentStep,
    firstApproved: firstApproved === undefined ? null : { at: instant(firstApproved.approved_at), name: firstApproved.approver_name ?? firstApproved.client_name }
  };
};

export const loadActivation = async (transaction: ContentTransaction, agencyId: string): Promise<ContentActivationResponse['data']> => {
  const facts = await loadFacts(transaction, agencyId);
  return { ...facts, steps: await loadSteps(transaction, agencyId) };
};
