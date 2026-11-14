import { z } from 'zod';

import {
  ApprovalNoteSchema,
  ApproveContentByAgencyRequestSchema,
  ContentFormatSchema,
  ContentPlatformSchema,
  ContentPeriodQuerySchema
} from './contents.js';
import { CommentBodySchema } from './conversations.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * The contents of a client as the portal sees them (specs/conteudo.md sections 2, 5 rule 1 and 6; issue #257).
 *
 * The portal never receives the work of the agency: no subtask, no person in charge, no internal deadline, no one's
 * user id, and nothing but the title, the day and the format while the content is in production. That last rule is
 * the shape of the schemas, not a field left out by a handler: a content in production is its own strict schema, so a
 * caption that reached it would fail the response instead of being sent.
 */

/** The content of a client in production: the title, the day and the format, and nothing else. */
export const PortalContentInProductionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  format: ContentFormatSchema,
  publishOn: z.string(),
  status: z.literal('in_production')
}).strict();

/** The photo of who sent the round of a content, served by the portal itself under the guard of the client: the path is relative to the API. */
export const PORTAL_SENDER_PHOTO_PATH = /^\/clients\/[0-9a-f-]{36}\/contents\/[0-9a-f-]{36}\/sender-photo$/i;

/**
 * Who of the agency sent the round, as the portal shows it ("Recado de João Pereira, da Agência Horizonte"): the name and the path of the
 * photo, `null` when the person has none. The path is `/clients/:clientId/contents/:contentId/sender-photo`, relative to the API, and the
 * route answers the bytes of the image (404 for no photo or no access): an address of the storage would carry the key of the object, which
 * names the account of the sender. No e-mail, role, id or membership of the collaborator.
 */
export const PortalApprovalSenderSchema = z.object({
  name: z.string(),
  photoUrl: z.string().regex(PORTAL_SENDER_PHOTO_PATH).nullable()
}).strict();

/**
 * What the agency asked of the client when it sent the content (decision 2026-11-11): the deadline as an instant (`dueAt`) and as the São
 * Paulo day of that instant (`dueOn`), the note, the instant it was sent and who sent it. The batch stays with the agency. `sentBy` is
 * `null` for a round with no readable sender; the approval link answers the day (`dueOn`) and the note only: its `dueAt`, `sentAt` and
 * `sentBy` are `null`.
 */
export const PortalContentApprovalSchema = z.object({
  dueAt: z.string().datetime().nullable(),
  dueOn: z.string().nullable(),
  note: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  sentBy: PortalApprovalSenderSchema.nullable()
}).strict();

/**
 * From "awaiting approval" on, as the calendar and the feed need it: no caption and no media. `approval` is `null` when the content was
 * never sent in a round (sent before the rounds existed).
 */
export const PortalContentOpenListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  platform: ContentPlatformSchema,
  format: ContentFormatSchema,
  publishOn: z.string(),
  publishAtTime: z.string().nullable(),
  status: z.enum(['awaiting_approval', 'adjusting', 'approved', 'published']),
  coverAssetId: z.string().uuid().nullable(),
  thumbnailAssetId: z.string().uuid().nullable(),
  publishedOn: z.string().nullable(),
  approval: PortalContentApprovalSchema.nullable()
}).strict();

export const PortalContentListItemSchema = z.union([PortalContentInProductionSchema, PortalContentOpenListItemSchema]);

/** A media of the post: its id, its place and whether it is an image or a video; the signed address is the media route's, never this one's. */
export const PortalContentMediaItemSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  kind: z.enum(['image', 'video'])
}).strict();

/**
 * The post, with its caption and media. `revision` is what the person read: the approval and the request for changes
 * carry it back, so a caption edited between the reading and the click is refused instead of approved unseen.
 */
export const PortalContentOpenDetailSchema = PortalContentOpenListItemSchema.omit({ thumbnailAssetId: true }).extend({
  caption: z.string().nullable(),
  revision: z.number().int().positive(),
  media: z.array(PortalContentMediaItemSchema)
}).strict();

export const PortalContentDetailSchema = z.union([PortalContentInProductionSchema, PortalContentOpenDetailSchema]);

/** The contents of a period, both ends inclusive; the same ceilings and envelope as every period query. */
export const PortalContentPeriodResponseSchema = z.object({
  data: z.array(PortalContentListItemSchema),
  meta: z.object({
    from: z.string(),
    to: z.string(),
    count: z.number().int().nonnegative()
  }).strict()
}).strict();

export const PortalContentAwaitingQuerySchema = PaginationInputSchema;
/** What waits for the person, the deadline that comes first first (a content with no deadline last, by its publication day). */
export const PortalContentAwaitingResponseSchema = createPaginatedResponseSchema(PortalContentOpenListItemSchema);

/**
 * The progress of the month for the Início of the portal, "Boa notícia" (decision 2026-11-11): of the contents of the month of today (São
 * Paulo) that are not cancelled (`total`), how many are approved or published (`approved`); and the next post to go on air: the earliest
 * approved content that has not been published and whose publication day has not passed (and, with an hour, whose hour has not). `next` is
 * `null` when there is none; `publishAtTime` is `null` for an approved content with no hour.
 */
export const PortalContentProgressResponseSchema = z.object({
  data: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    approved: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    next: z.object({
      id: z.string().uuid(),
      title: z.string(),
      publishOn: z.string(),
      publishAtTime: z.string().nullable()
    }).strict().nullable()
  }).strict()
}).strict();

export const PortalContentPathParamsSchema = z.object({
  clientId: z.string().uuid(),
  contentId: z.string().uuid()
}).strict();

export const PortalContentPeriodQuerySchema = ContentPeriodQuerySchema;

export const PortalContentMediaPathParamsSchema = PortalContentPathParamsSchema.extend({
  assetId: z.string().uuid()
}).strict();

/** The portal signs the original or the thumbnail only; the preview of a video is not offered to it. */
export const PortalContentMediaUrlQuerySchema = z.object({
  variant: z.enum(['original', 'thumbnail']).optional().default('original')
}).strict();

// The same shape as the agency's, declared on its own so that the OpenAPI component of the published route is not renamed.
export const PortalContentMediaUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime()
}).strict();

/**
 * Body of `POST .../approve`: only the revision the person read. Who approved and when are the database's, taken from the
 * session, so no field of the body can name them (the schema is strict).
 */
export const PortalApproveContentRequestSchema = z.object({
  revision: ApproveContentByAgencyRequestSchema.shape.revision
}).strict();

/**
 * Body of `POST .../approve` of the portal: the revision the person read and, optionally, a note to the agency (decision 2026-11-11), up to
 * 500 visible characters like the note of the agency, which enters the conversation of the content as a comment of the client in the same
 * transaction as the approval. The approval link of the e-mail takes no note (`PortalApproveContentRequestSchema`).
 */
export const PortalApproveContentWithNoteRequestSchema = z.object({
  revision: ApproveContentByAgencyRequestSchema.shape.revision,
  note: ApprovalNoteSchema.optional()
}).strict();

/**
 * Body of `POST .../request-changes`: the revision read and the comment, which is required and enters the conversation of
 * the content. The comment follows the one rule of free text of the conversations (no control, invisible or format
 * character, never empty, at most 5000 bytes).
 */
export const PortalRequestContentChangesRequestSchema = z.object({
  revision: ApproveContentByAgencyRequestSchema.shape.revision,
  comment: CommentBodySchema
}).strict();

export type PortalContentInProduction = z.infer<typeof PortalContentInProductionSchema>;
export type PortalContentListItem = z.infer<typeof PortalContentListItemSchema>;
export type PortalContentApproval = z.infer<typeof PortalContentApprovalSchema>;
export type PortalContentOpenListItem = z.infer<typeof PortalContentOpenListItemSchema>;
export type PortalContentDetail = z.infer<typeof PortalContentDetailSchema>;
export type PortalContentPeriodResponse = z.infer<typeof PortalContentPeriodResponseSchema>;
export type PortalContentAwaitingResponse = z.infer<typeof PortalContentAwaitingResponseSchema>;
export type PortalContentMediaUrlQuery = z.infer<typeof PortalContentMediaUrlQuerySchema>;
export type PortalContentMediaUrlResponse = z.infer<typeof PortalContentMediaUrlResponseSchema>;
export type PortalApproveContentRequest = z.infer<typeof PortalApproveContentRequestSchema>;
export type PortalApproveContentWithNoteRequest = z.infer<typeof PortalApproveContentWithNoteRequestSchema>;
export type PortalApprovalSender = z.infer<typeof PortalApprovalSenderSchema>;
export type PortalContentProgressResponse = z.infer<typeof PortalContentProgressResponseSchema>;
export type PortalRequestContentChangesRequest = z.infer<typeof PortalRequestContentChangesRequestSchema>;
