import type { ContentSummaryResponse } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { CLOCK_CTES } from './clock-sql.js';
import { contentScheduledSql } from './deadline-sql.js';
import type { ContentTransaction } from './service.js';

/**
 * The counters of the Início of the agency (decisions 2026-11-11), in one pass over the contents of the agency's active clients that this
 * person reads (the policy of `contents`, as the calendar and "Parado no cliente" read them):
 *
 * - `awaitingClient` and `overdueAwaitingClient`: what waits for the client, and the part of it whose publication day (São Paulo) passed.
 * - `approvedThisMonth` and `approvedLastMonth`: approved or published contents by the São Paulo day of the approval, in the month of
 *   today and in the month before; today's count of each, not a history. An approval outside the platform also has its day.
 * - `scheduled`: the approved contents with an hour whose instant has not passed (`contentIsScheduled`), and the day of the last.
 *
 * One instant (`now`, or the database's clock) gives the day, the months and the hour of day (`clock-sql.ts`), so the counters agree.
 */
export const loadContentSummary = async (
  transaction: ContentTransaction,
  input: { readonly agencyId: string; readonly now: Date | undefined }
): Promise<ContentSummaryResponse['data']> => {
  const scheduled = contentScheduledSql('clock.today', 'clock.local_time');
  const result = await raw<{ readonly rows: ReadonlyArray<{
    awaiting: string | number;
    overdue: string | number;
    approved_this_month: string | number;
    approved_last_month: string | number;
    scheduled_count: string | number;
    scheduled_last: string | null;
  }> }>(transaction, `
    with ${CLOCK_CTES}
    select
      count(*) filter (where content.status = 'awaiting_approval') as awaiting,
      count(*) filter (where content.status = 'awaiting_approval' and content.publish_on < clock.today) as overdue,
      count(*) filter (
        where content.status in ('approved', 'published')
          and app_private.sao_paulo_date(content.approved_at) >= clock.month_start
          and app_private.sao_paulo_date(content.approved_at) < clock.next_month_start
      ) as approved_this_month,
      count(*) filter (
        where content.status in ('approved', 'published')
          and app_private.sao_paulo_date(content.approved_at) >= clock.last_month_start
          and app_private.sao_paulo_date(content.approved_at) < clock.month_start
      ) as approved_last_month,
      count(*) filter (where ${scheduled}) as scheduled_count,
      (max(content.publish_on) filter (where ${scheduled}))::text as scheduled_last
    from public.contents content
    join public.clients client on client.id = content.client_id
    cross join clock
    where client.agency_id = ?::uuid and client.status = 'active'
      and content.status in ('awaiting_approval', 'approved', 'published')
  `, [input.now?.toISOString() ?? null, input.agencyId]);

  const row = result.rows[0];
  return {
    awaitingClient: Number(row?.awaiting ?? 0),
    overdueAwaitingClient: Number(row?.overdue ?? 0),
    approvedThisMonth: Number(row?.approved_this_month ?? 0),
    approvedLastMonth: Number(row?.approved_last_month ?? 0),
    scheduled: { count: Number(row?.scheduled_count ?? 0), lastPublishOn: row?.scheduled_last ?? null }
  };
};
