import { z } from 'zod';

import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * The notifications inside the app (specs/notificacoes.md sections 3, 4 and 6; decision 2026-11-11). A notification is the person's alone:
 * the routes read it as the person and the database decides what is theirs, so no request carries a person, a kind, a summary or a time.
 * Everything here is `.strict()`.
 */

export const NOTIFICATION_KINDS = [
  'content_approved',
  'content_changes_requested',
  'material_request_answered',
  'approval_deadline_passed',
  'invitation_accepted'
] as const;

export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** The day-to-day listing is 20 a page (specs/notificacoes.md section 6); the shared ceiling of `pageSize` still holds. */
export const NOTIFICATIONS_PAGE_SIZE = 20;

/** The summary is built by the database and is never longer than this (rule 6: no body of a note or a comment goes in it). */
export const NOTIFICATION_SUMMARY_MAX_LENGTH = 160;

/**
 * Where opening the notification goes. Each destination names what its screen needs and nothing else: the content of a client, the request
 * for material of a client, or the list of collaborators.
 */
export const NotificationDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content'), clientId: z.string().uuid(), contentId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('material-request'), clientId: z.string().uuid(), threadId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('collaborators') }).strict()
]);

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  kind: NotificationKindSchema,
  summary: z.string().min(1).refine((value) => Array.from(value).length <= NOTIFICATION_SUMMARY_MAX_LENGTH, 'must be at most 160 characters'),
  createdAt: z.string().datetime(),
  /** `null` while unread; the instant the database stamped when the person read it. */
  readAt: z.string().datetime().nullable(),
  destination: NotificationDestinationSchema
}).strict();

/** `unread=true` lists the ones not read yet; a query string carries text, so only the word `true` names the filter. */
export const NotificationListQuerySchema = PaginationInputSchema.extend({
  unread: z.literal('true').optional()
}).strict();

export const NotificationListResponseSchema = createPaginatedResponseSchema(NotificationSchema);

/** The dot of the bell: how many the person has not read yet. */
export const NotificationUnreadCountResponseSchema = z.object({
  data: z.object({ count: z.number().int().nonnegative() }).strict()
}).strict();

export const AgencyNotificationPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  notificationId: z.string().uuid()
}).strict();

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type NotificationDestination = z.infer<typeof NotificationDestinationSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
export type NotificationUnreadCountResponse = z.infer<typeof NotificationUnreadCountResponseSchema>;
export type AgencyNotificationPathParams = z.infer<typeof AgencyNotificationPathParamsSchema>;
