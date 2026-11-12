import { raw, type DatabaseClient } from '@ageniza/database';
import type { Notification, ResolvedPagination } from '@ageniza/contracts';

export type NotificationTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface NotificationRow {
  readonly id: string;
  readonly kind: Notification['kind'];
  readonly summary: string;
  readonly content_id: string | null;
  readonly thread_id: string | null;
  readonly client_id: string | null;
  readonly created_at: string | Date;
  readonly read_at: string | Date | null;
}

export interface NotificationPage {
  readonly items: readonly NotificationRow[];
  readonly totalItems: number;
}

const toIso = (value: string | Date): string => new Date(value).toISOString();

const destinationOf = (row: NotificationRow): Notification['destination'] => {
  switch (row.kind) {
    case 'content_approved':
    case 'content_changes_requested':
    case 'approval_deadline_passed':
      if (row.client_id === null || row.content_id === null) throw new Error('A content notification has no client or content.');
      return { type: 'content', clientId: row.client_id, contentId: row.content_id };
    case 'material_request_answered':
      if (row.client_id === null || row.thread_id === null) throw new Error('A material request notification has no client or thread.');
      return { type: 'material-request', clientId: row.client_id, threadId: row.thread_id };
    case 'invitation_accepted':
      return { type: 'collaborators' };
  }
};

export const notificationFromRow = (row: NotificationRow): Notification => ({
  id: row.id,
  kind: row.kind,
  summary: row.summary,
  createdAt: toIso(row.created_at),
  readAt: row.read_at === null ? null : toIso(row.read_at),
  destination: destinationOf(row)
});

const NOTIFICATIONS_OF_AGENCY = `
  from public.notifications notification
  where notification.agency_id = ?::uuid`;

/**
 * One page of the notifications of the person in one agency, the latest first, the id breaking a tie so a page boundary is stable.
 * No filter by person here: the policy of `public.notifications` shows the rows the bound person may read (their own, with the
 * link and the permission of the subject still held) and nothing else, and no route widens it. `count(*) over ()` rides the
 * page's own snapshot.
 */
export const listNotifications = async (
  transaction: NotificationTransaction,
  agencyId: string,
  filters: { readonly unread: boolean },
  pagination: Pick<ResolvedPagination, 'pageSize' | 'offset'>
): Promise<NotificationPage> => {
  const unread = filters.unread ? '\n    and notification.read_at is null' : '';
  const result = await raw<RawRows<NotificationRow & { readonly total: string | number }>>(transaction, `
    select notification.id, notification.kind, notification.summary, notification.content_id, notification.thread_id,
      notification.client_id, notification.created_at, notification.read_at, count(*) over () as total
    ${NOTIFICATIONS_OF_AGENCY}${unread}
    order by notification.created_at desc, notification.id desc
    limit ? offset ?
  `, [agencyId, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) return { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) };
  // An empty first page is the whole truth; a second count could only answer from another snapshot.
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const count = await raw<RawRows<{ total: string | number }>>(
    transaction,
    `select count(*) as total ${NOTIFICATIONS_OF_AGENCY}${unread}`,
    [agencyId]
  );
  return { items: [], totalItems: Number(count.rows[0]?.total ?? 0) };
};

export const countUnreadNotifications = async (transaction: NotificationTransaction, agencyId: string): Promise<number> => {
  const result = await raw<RawRows<{ total: string | number }>>(
    transaction,
    `select count(*) as total ${NOTIFICATIONS_OF_AGENCY}\n    and notification.read_at is null`,
    [agencyId]
  );
  return Number(result.rows[0]?.total ?? 0);
};

/**
 * Marks one notification of the bound person as read. The answer is the function's own: `false` is "not yours, not in this agency,
 * not readable any more, or not there", which the route turns into one 404 and never tells apart. Reading it again is not an error.
 */
export const markNotificationRead = async (transaction: NotificationTransaction, agencyId: string, notificationId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ found: unknown }>>(
    transaction,
    'select app_private.read_notification(?::uuid, ?::uuid) as found',
    [agencyId, notificationId]
  );
  const found = result.rows[0]?.found;
  if (typeof found !== 'boolean') throw new Error('read_notification() did not return whether the notification was found.');
  return found;
};

/** Marks every unread notification of the bound person in the agency as read, and says how many it marked. */
export const markAllNotificationsRead = async (transaction: NotificationTransaction, agencyId: string): Promise<number> => {
  const result = await raw<RawRows<{ marked: unknown }>>(transaction, 'select app_private.read_all_notifications(?::uuid) as marked', [agencyId]);
  const marked = result.rows[0]?.marked;
  if (typeof marked !== 'number' || !Number.isInteger(marked)) throw new Error('read_all_notifications() did not return how many it marked.');
  return marked;
};
