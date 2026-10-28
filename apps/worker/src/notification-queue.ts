import { raw, type DatabaseClient } from '@ageniza/database';

export const NOTIFICATION_TYPES = ['content_awaiting_approval', 'content_published'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What an e-mail needs about one item of the queue: the only thing the worker can read, since RLS gives it no row. */
export interface ClaimedNotification {
  readonly itemId: string;
  readonly claimToken: string;
  /** Kept as the database wrote it: a type this worker does not know is released, not guessed at. */
  readonly notificationType: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly agencyName: string;
  readonly recipientPortalAccessId: string;
  readonly recipientEmail: string;
  readonly contentId: string;
  readonly contentTitle: string;
  /** `YYYY-MM-DD`, or null. */
  readonly contentPublishOn: string | null;
}

/**
 * The four functions of the notification queue (migrations 20261011000100 and 20261011000800), which are all the worker may
 * call: `ageniza_app` has no privilege on the table. Each call is a transaction of its own, so the claim commits its lease
 * before anything is sent and the recheck holds its lock of the client only while it reads, never around the send.
 */
export interface NotificationQueue {
  claim(groupLimit: number): Promise<ClaimedNotification[]>;
  /**
   * The approval link of an e-mail "contents to approve" (issue #712), issued from the items the claim still holds: the database stores
   * the hash of the token and ties the link to the contents of those items. The token is the worker's and goes only into the e-mail.
   */
  issueApprovalLink(itemIds: readonly string[], claimToken: string, tokenHash: string): Promise<void>;
  /** Right before the send: drops what stopped being true and returns what still holds. */
  recheck(itemIds: readonly string[], claimToken: string): Promise<ClaimedNotification[]>;
  markSent(itemIds: readonly string[], claimToken: string): Promise<number>;
  /** `errorCode` is a machine token, never the text of the provider, which carries addresses. */
  fail(itemIds: readonly string[], claimToken: string, errorCode: string): Promise<number>;
}

const COLUMNS = `item_id, claim_token, notification_type, client_id, client_name, agency_name, recipient_portal_access_id, recipient_email,
  content_id, content_title, content_publish_on::text as content_publish_on`;

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`The notification queue did not return ${column}.`);
  return value;
};

const toClaimed = (row: Record<string, unknown>): ClaimedNotification => {
  const publishOn = row.content_publish_on;
  if (publishOn !== null && typeof publishOn !== 'string') throw new Error('The notification queue did not return content_publish_on.');
  return {
    itemId: text(row, 'item_id'),
    claimToken: text(row, 'claim_token'),
    notificationType: text(row, 'notification_type'),
    clientId: text(row, 'client_id'),
    clientName: text(row, 'client_name'),
    agencyName: text(row, 'agency_name'),
    recipientPortalAccessId: text(row, 'recipient_portal_access_id'),
    recipientEmail: text(row, 'recipient_email'),
    contentId: text(row, 'content_id'),
    contentTitle: text(row, 'content_title'),
    contentPublishOn: publishOn
  };
};

const count = (rows: ReadonlyArray<Record<string, unknown>>, column: string): number => {
  const value = Number(rows[0]?.[column]);
  if (!Number.isInteger(value)) throw new Error(`The notification queue did not return ${column}.`);
  return value;
};

export const createNotificationQueue = (database: DatabaseClient): NotificationQueue => ({
  claim: (groupLimit) => database.transaction(async (transaction) => {
    const result = await raw<{ rows: Array<Record<string, unknown>> }>(transaction, `select ${COLUMNS} from app_private.claim_notification_batch(?::integer)`, [groupLimit]);
    return result.rows.map(toClaimed);
  }),
  issueApprovalLink: (itemIds, claimToken, tokenHash) => database.transaction(async (transaction) => {
    await raw(transaction, 'select app_private.issue_portal_approval_link(?::uuid[], ?::uuid, ?)', [[...itemIds], claimToken, tokenHash]);
  }),
  recheck: (itemIds, claimToken) => database.transaction(async (transaction) => {
    const result = await raw<{ rows: Array<Record<string, unknown>> }>(
      transaction, `select ${COLUMNS} from app_private.recheck_notifications(?::uuid[], ?::uuid)`, [[...itemIds], claimToken]
    );
    return result.rows.map(toClaimed);
  }),
  markSent: (itemIds, claimToken) => database.transaction(async (transaction) => {
    const result = await raw<{ rows: Array<Record<string, unknown>> }>(
      transaction, 'select app_private.mark_notifications_sent(?::uuid[], ?::uuid) as marked', [[...itemIds], claimToken]
    );
    return count(result.rows, 'marked');
  }),
  fail: (itemIds, claimToken, errorCode) => database.transaction(async (transaction) => {
    const result = await raw<{ rows: Array<Record<string, unknown>> }>(
      transaction, 'select app_private.fail_notifications(?::uuid[], ?::uuid, ?::text) as failed', [[...itemIds], claimToken, errorCode]
    );
    return count(result.rows, 'failed');
  })
});
