import { z } from 'zod';

import {
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

/** From "awaiting approval" on, as the calendar and the feed need it: no caption and no media. */
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
  publishedOn: z.string().nullable()
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
export const PortalContentAwaitingResponseSchema = createPaginatedResponseSchema(PortalContentOpenListItemSchema);

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
export type PortalContentOpenListItem = z.infer<typeof PortalContentOpenListItemSchema>;
export type PortalContentDetail = z.infer<typeof PortalContentDetailSchema>;
export type PortalContentPeriodResponse = z.infer<typeof PortalContentPeriodResponseSchema>;
export type PortalContentAwaitingResponse = z.infer<typeof PortalContentAwaitingResponseSchema>;
export type PortalContentMediaUrlQuery = z.infer<typeof PortalContentMediaUrlQuerySchema>;
export type PortalContentMediaUrlResponse = z.infer<typeof PortalContentMediaUrlResponseSchema>;
export type PortalApproveContentRequest = z.infer<typeof PortalApproveContentRequestSchema>;
export type PortalRequestContentChangesRequest = z.infer<typeof PortalRequestContentChangesRequestSchema>;
