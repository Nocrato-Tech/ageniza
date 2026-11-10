import type { ContentActivationResponse } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { ContentTransaction } from './service.js';

/**
 * Four yes/no facts about the agency's contents, each an `exists` that stops at the first row the policy lets through.
 * "Sent" is a content that left production for the client (or was approved, which needs it); "approved by the client" mirrors
 * how the detail names the approver: an approver that is not an approval outside the platform (which always carries a reason).
 */
export const loadActivation = async (transaction: ContentTransaction, agencyId: string): Promise<ContentActivationResponse['data']> => {
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
