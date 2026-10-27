import { contentsAwaitingApprovalEmail, contentsPublishedEmail, type EmailMessage, type EmailSender } from '@ageniza/email';

import type { ClaimedNotification, NotificationQueue } from './notification-queue.js';
import type { DurableJob, DurableJobContext, DurableJobDefinition } from './queue.js';

export const CLIENT_CONTENT_EMAIL_JOB_NAME = 'notifications.send-client-content-emails';

/**
 * Every minute, and once at every start. The queue decides WHEN an item may leave (15 minutes after the last send for
 * approval, the end of the day in Brasília for the summary of "published"); this clock only asks it, so the smallest unit
 * of a cron is the delay a ready e-mail can have.
 */
export const CLIENT_CONTENT_EMAIL_SCHEDULE = { cron: '* * * * *', timeZone: 'America/Sao_Paulo' } as const;

// One claim is a lease of 10 minutes, and an e-mail can take a while to fail: a claim is small enough for the last group of
// it to be rechecked well inside the lease (the recheck refuses an item whose lease ran out, so a late group is skipped, never sent).
const GROUPS_PER_CLAIM = 10;
const MAX_CLAIMS_PER_RUN = 6;
const STOP_STARTING_AFTER_MS = 4 * 60 * 1000;

export interface ClientContentEmailJobDependencies {
  readonly queue: NotificationQueue;
  readonly sender: Pick<EmailSender, 'send'>;
  /** The origin of the web app: where the link to the portal of the client points. */
  readonly appPublicUrl: string;
  /** Test seam. */
  readonly now?: () => number;
}

const TEMPLATES = {
  content_awaiting_approval: { template: 'contents-awaiting-approval', compose: contentsAwaitingApprovalEmail },
  content_published: { template: 'contents-published', compose: contentsPublishedEmail }
} as const;

type KnownType = keyof typeof TEMPLATES;
const isKnownType = (type: string): type is KnownType => Object.hasOwn(TEMPLATES, type);

/** The portal of the client. Signing in is what authorizes opening it, so the link carries nothing of the person. */
export const portalUrlFor = (appPublicUrl: string, clientId: string): string =>
  new URL(`/portal/${encodeURIComponent(clientId)}/calendario`, appPublicUrl).toString();

/**
 * A machine token for the queue, never the text of the provider: that carries the address the e-mail went to. The numeric
 * reply of the server says whether to expect it to pass on a retry, and the code of the transport names a network failure.
 */
export const failureCodeOf = (error: unknown): string => {
  const details = (typeof error === 'object' && error !== null ? error : {}) as { responseCode?: unknown; code?: unknown };
  if (typeof details.responseCode === 'number') return details.responseCode >= 500 ? 'smtp_rejected' : 'smtp_temporary';
  if (typeof details.code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(details.code)) return `smtp_${details.code.toLowerCase()}`;
  return 'smtp_failed';
};

interface Group {
  readonly claimToken: string;
  readonly type: string;
  readonly items: ClaimedNotification[];
}

// The claim returns the rows of one person and client and type together; the key says so again, so a row of another group
// never rides in someone else's e-mail.
const groupsOf = (claimed: readonly ClaimedNotification[]): Group[] => {
  const groups = new Map<string, Group>();
  for (const item of claimed) {
    const key = [item.claimToken, item.recipientPortalAccessId, item.clientId, item.notificationType].join('|');
    const group = groups.get(key) ?? { claimToken: item.claimToken, type: item.notificationType, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
};

// The e-mail has left: a database hiccup here would make the next claim send it again, so the stamp is tried a few times first.
const markSentWithRetry = async (queue: NotificationQueue, itemIds: readonly string[], claimToken: string): Promise<number> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await queue.markSent(itemIds, claimToken);
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
};

interface Totals { claimedGroups: number; sent: number; droppedItems: number; failedGroups: number; releasedGroups: number }

const messageOf = (type: KnownType, items: readonly ClaimedNotification[], appPublicUrl: string): EmailMessage => {
  const first = items[0]!;
  return TEMPLATES[type].compose({
    agencyName: first.agencyName,
    clientName: first.clientName,
    portalUrl: portalUrlFor(appPublicUrl, first.clientId),
    items: items.map((item) => ({ title: item.contentTitle, publishOn: item.contentPublishOn }))
  });
};

/**
 * The e-mail to the client (issue #260). Claim, recheck, send, mark: each step is its own short transaction of the queue
 * (`NotificationQueue`), the claim is a lease that no other worker takes, and the recheck, which the lease does not cover,
 * judges again whether the client is active, the agency not suspended, the person still linked and the content still in the
 * state the e-mail talks about, as close to the send as a transaction can be.
 *
 * Delivery is at least once and an e-mail can repeat only if the worker dies between the send and the mark; a failure of the
 * provider releases the items with a code and a delay, so it neither loses nor repeats them. The log carries counts, a group's
 * type and an error code, never an address, a title, a name, a token or a link.
 */
export const clientContentEmailJob = (
  dependencies: ClientContentEmailJobDependencies
): DurableJobDefinition<Record<string, never>> => ({
  name: CLIENT_CONTENT_EMAIL_JOB_NAME,
  schedule: CLIENT_CONTENT_EMAIL_SCHEDULE,
  runOnStart: true,
  retryLimit: 1,
  expireInSeconds: 900,
  concurrency: 1,
  async handler(_job: DurableJob<Record<string, never>>, context: DurableJobContext): Promise<void> {
    const { queue, sender, appPublicUrl } = dependencies;
    const now = dependencies.now ?? Date.now;
    const startedAt = now();
    const totals: Totals = { claimedGroups: 0, sent: 0, droppedItems: 0, failedGroups: 0, releasedGroups: 0 };

    const release = async (group: Group, items: readonly ClaimedNotification[], code: string): Promise<void> => {
      await queue.fail(items.map((item) => item.itemId), group.claimToken, code);
      totals.releasedGroups += 1;
    };

    for (let claims = 0; claims < MAX_CLAIMS_PER_RUN && !context.signal.aborted && now() - startedAt < STOP_STARTING_AFTER_MS; claims += 1) {
      const groups = groupsOf(await queue.claim(GROUPS_PER_CLAIM));
      if (groups.length === 0) break;
      totals.claimedGroups += groups.length;

      for (const [position, group] of groups.entries()) {
        if (context.signal.aborted) {
          for (const left of groups.slice(position)) await release(left, left.items, 'worker_stopping');
          break;
        }
        if (!isKnownType(group.type)) {
          await release(group, group.items, 'unknown_type');
          context.logger.warn({ notificationType: group.type, items: group.items.length }, 'Released items of a notification type this worker does not send');
          continue;
        }

        const kept = await queue.recheck(group.items.map((item) => item.itemId), group.claimToken);
        totals.droppedItems += group.items.length - kept.length;
        if (kept.length === 0) continue;

        const keptIds = kept.map((item) => item.itemId);
        try {
          await sender.send({ ...messageOf(group.type, kept, appPublicUrl), to: kept[0]!.recipientEmail, template: TEMPLATES[group.type].template });
        } catch (error) {
          const errorCode = failureCodeOf(error);
          totals.failedGroups += 1;
          await queue.fail(keptIds, group.claimToken, errorCode);
          context.logger.warn({ notificationType: group.type, items: kept.length, errorCode }, 'The e-mail to the client was not sent and its items were released');
          continue;
        }
        totals.sent += 1;
        const marked = await markSentWithRetry(queue, keptIds, group.claimToken);
        if (marked !== keptIds.length) {
          context.logger.warn({ notificationType: group.type, expected: keptIds.length, marked }, 'Some items were no longer held by this claim when the e-mail left');
        }
      }
    }

    context.logger.info({ ...totals }, 'E-mails to the clients processed');
  }
});
