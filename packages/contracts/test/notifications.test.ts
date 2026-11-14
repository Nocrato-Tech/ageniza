import { describe, expect, it } from 'vitest';

import {
  AgencyNotificationPathParamsSchema,
  NOTIFICATIONS_PAGE_SIZE,
  NOTIFICATION_KINDS,
  NOTIFICATION_SUMMARY_MAX_LENGTH,
  NotificationDestinationSchema,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationSchema,
  NotificationUnreadCountResponseSchema,
  PAGE_SIZE_CEILING,
  resolvePagination
} from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const contentId = '33333333-3333-4333-8333-333333333333';
const threadId = '44444444-4444-4444-8444-444444444444';

const notification = {
  id,
  kind: 'content_approved',
  summary: 'Studio Aurora aprovou "Reels de lançamento"',
  createdAt: '2026-11-12T15:30:00.000Z',
  readAt: null,
  destination: { type: 'content', clientId, contentId }
};

describe('the notification item', () => {
  it('has the five kinds of the product and no other', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([
      'approval_deadline_passed', 'content_approved', 'content_changes_requested', 'invitation_accepted', 'material_request_answered'
    ]);
    for (const kind of NOTIFICATION_KINDS) expect(NotificationSchema.safeParse({ ...notification, kind }).success, kind).toBe(true);
    for (const kind of ['content_published', 'Content_Approved', '', null, 7]) {
      expect(NotificationSchema.safeParse({ ...notification, kind }).success, String(kind)).toBe(false);
    }
  });

  it('is unread with a null instant, and read with the instant the database stamped', () => {
    expect(NotificationSchema.parse(notification)).toEqual(notification);
    expect(NotificationSchema.parse({ ...notification, readAt: '2026-11-12T16:00:00.000Z' }).readAt).toBe('2026-11-12T16:00:00.000Z');
    for (const readAt of ['ontem', '2026-11-12', 0, undefined]) {
      expect(NotificationSchema.safeParse({ ...notification, readAt }).success, String(readAt)).toBe(false);
    }
  });

  it('keeps the summary between 1 and 160 characters', () => {
    expect(NotificationSchema.safeParse({ ...notification, summary: 'x'.repeat(NOTIFICATION_SUMMARY_MAX_LENGTH) }).success).toBe(true);
    expect(NotificationSchema.safeParse({ ...notification, summary: '😀'.repeat(NOTIFICATION_SUMMARY_MAX_LENGTH) }).success).toBe(true);
    for (const summary of ['', 'x'.repeat(NOTIFICATION_SUMMARY_MAX_LENGTH + 1), '😀'.repeat(NOTIFICATION_SUMMARY_MAX_LENGTH + 1), null, 3]) {
      expect(NotificationSchema.safeParse({ ...notification, summary }).success, String(summary).slice(0, 12)).toBe(false);
    }
  });

  it('refuses a field the product does not have, so the recipient, the agency and the subject keys never leave the server', () => {
    for (const extra of [{ recipientUserId: id }, { agencyId: clientId }, { contentId }, { invitationId: id }, { approvalRoundId: id }, { body: 'texto' }]) {
      expect(NotificationSchema.safeParse({ ...notification, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const missing of ['id', 'kind', 'summary', 'createdAt', 'readAt', 'destination'] as const) {
      const without = Object.fromEntries(Object.entries(notification).filter(([key]) => key !== missing));
      expect(NotificationSchema.safeParse(without).success, missing).toBe(false);
    }
    expect(NotificationSchema.safeParse({ ...notification, id: 'not-a-uuid' }).success).toBe(false);
    expect(NotificationSchema.safeParse({ ...notification, createdAt: 'agora' }).success).toBe(false);
  });
});

describe('where a notification goes', () => {
  it('names what the screen needs: the content of a client, the request of a client, or the collaborators', () => {
    expect(NotificationDestinationSchema.parse({ type: 'content', clientId, contentId })).toEqual({ type: 'content', clientId, contentId });
    expect(NotificationDestinationSchema.parse({ type: 'material-request', clientId, threadId })).toEqual({ type: 'material-request', clientId, threadId });
    expect(NotificationDestinationSchema.parse({ type: 'collaborators' })).toEqual({ type: 'collaborators' });
  });

  it('refuses a destination with a key that is not its own, a missing one, an unknown type and a malformed id', () => {
    for (const destination of [
      { type: 'content', clientId },
      { type: 'content', contentId },
      { type: 'content', clientId, contentId, threadId },
      { type: 'material-request', clientId, contentId },
      { type: 'material-request', threadId },
      { type: 'collaborators', clientId },
      { type: 'client' },
      { clientId, contentId },
      { type: 'content', clientId: 'x', contentId },
      { type: 'content', clientId, contentId: '' },
      {},
      null
    ]) {
      expect(NotificationDestinationSchema.safeParse(destination).success, JSON.stringify(destination)).toBe(false);
    }
  });
});

describe('the listing of notifications', () => {
  it('is 20 a page, under the global ceiling, with the pagination of every other listing', () => {
    expect(NOTIFICATIONS_PAGE_SIZE).toBe(20);
    expect(resolvePagination(NotificationListQuerySchema.parse({}), NOTIFICATIONS_PAGE_SIZE)).toEqual({ page: 1, pageSize: 20, offset: 0 });
    expect(resolvePagination(NotificationListQuerySchema.parse({ page: '3' }), NOTIFICATIONS_PAGE_SIZE)).toEqual({ page: 3, pageSize: 20, offset: 40 });
    expect(resolvePagination(NotificationListQuerySchema.parse({ pageSize: '1000' }), NOTIFICATIONS_PAGE_SIZE).pageSize).toBe(PAGE_SIZE_CEILING);
  });

  it('filters by unread=true and nothing else: the person, the agency and the kind are not parameters', () => {
    expect(NotificationListQuerySchema.parse({ unread: 'true' })).toEqual({ unread: 'true' });
    for (const query of [{ unread: 'false' }, { unread: '1' }, { unread: true }, { unread: '' }, { kind: 'content_approved' }, { recipientUserId: id }, { agencyId: clientId }, { page: '0' }, { page: 'x' }]) {
      expect(NotificationListQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('answers items and the page metadata of the shared listing contract', () => {
    const response = { data: [notification], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } };
    expect(NotificationListResponseSchema.parse(response)).toEqual(response);
    expect(NotificationListResponseSchema.safeParse({ data: [{ ...notification, recipientUserId: id }], meta: response.meta }).success).toBe(false);
    expect(NotificationListResponseSchema.safeParse({ data: [notification] }).success).toBe(false);
    expect(NotificationListResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });
});

describe('the dot of the bell and the routes of one notification', () => {
  it('answers { data: { count } } with a count that is a whole number and never negative', () => {
    expect(NotificationUnreadCountResponseSchema.parse({ data: { count: 0 } })).toEqual({ data: { count: 0 } });
    expect(NotificationUnreadCountResponseSchema.parse({ data: { count: 12 } })).toEqual({ data: { count: 12 } });
    for (const response of [{ data: { count: -1 } }, { data: { count: 1.5 } }, { data: { count: '3' } }, { data: {} }, { count: 3 }, { data: { count: 3, unread: 3 } }, { data: { count: 3 }, meta: {} }]) {
      expect(NotificationUnreadCountResponseSchema.safeParse(response).success, JSON.stringify(response)).toBe(false);
    }
  });

  it('takes an agency and a notification, both UUIDs, and nothing else', () => {
    expect(AgencyNotificationPathParamsSchema.parse({ agencyId: clientId, notificationId: id })).toEqual({ agencyId: clientId, notificationId: id });
    for (const params of [{ agencyId: clientId }, { notificationId: id }, { agencyId: 'x', notificationId: id }, { agencyId: clientId, notificationId: 'x' }, { agencyId: clientId, notificationId: id, userId: id }]) {
      expect(AgencyNotificationPathParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false);
    }
  });
});
