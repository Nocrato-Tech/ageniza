import { z } from 'zod';

import { isCalendarDay } from './clients.js';
import {
  hasHiddenStoryCharacters,
  STORY_SCRIPT_PERIOD_MAX_DAYS,
  STORY_SCRIPT_PERIOD_MAX_ITEMS,
  StoryScriptPeriodQuerySchema,
  StoryScriptStatusSchema,
  storyScriptPeriodIssues
} from './story-scripts.js';

/**
 * Content of a client, agency side (specs/conteudo.md sections 3, 4 and 6; issue #254).
 *
 * The period query is the format Tarefas and Dashboard copy (docs/business/decisions/2026-10-11-consulta-por-periodo-teto-de-500-itens-e-formato-da-resposta.md): both ends
 * inclusive, a ceiling in days and in items, no pagination, and one `{ data, meta }` envelope whose `data`
 * holds one array per kind of item.
 */

/** The ceilings of the period query are the story scripts' (one decision, one number): 93 days and 500 items. */
export const CONTENT_PERIOD_MAX_DAYS = STORY_SCRIPT_PERIOD_MAX_DAYS;
export const CONTENT_PERIOD_MAX_ITEMS = STORY_SCRIPT_PERIOD_MAX_ITEMS;
export const CONTENT_TITLE_MAX_LENGTH = 120;
export const CONTENT_CAPTION_MAX_LENGTH = 2_200;
export const CONTENT_CAROUSEL_MAX_MEDIA = 20;

export const ContentPlatformSchema = z.enum(['instagram']);
export const ContentFormatSchema = z.enum(['image', 'carousel', 'reels', 'long_video', 'vsl']);
export const ContentStatusSchema = z.enum(['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled']);
export const ContentTaskStatusSchema = z.enum(['pending', 'delivered', 'approved']);

/** A real day of the calendar in the form the `date` column prints; the route never reads it in a time zone. */
export const CalendarDaySchema = z.string().refine(isCalendarDay, 'must be a real date in the form YYYY-MM-DD');

/** Hour and minute, 24-hour clock: the optional time of a publication. */
export const ContentTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time in the form HH:MM');

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LINE_BREAKS = /[\t\n\r]/;

const characterCount = (value: string): number => Array.from(value).length;

// One rule of free text in Conteúdo: the story script's, so a title, a caption and a scene refuse the same characters.
const visibleText = () => z.string()
  .refine((value) => !hasHiddenStoryCharacters(value), 'must not contain control, bidi or invisible characters')
  .refine((value) => !LONE_SURROGATE.test(value), 'must be valid text');

/** The title the client also sees: one line, 1 to 120 characters (the column counts characters, not bytes). */
export const ContentTitleSchema = z.string()
  .refine((value) => !LINE_BREAKS.test(value), 'must be one line')
  .pipe(visibleText())
  .transform((value) => value.trim())
  .pipe(z.string()
    .min(1, 'must not be empty')
    .refine((value) => characterCount(value) <= CONTENT_TITLE_MAX_LENGTH, `must be at most ${CONTENT_TITLE_MAX_LENGTH} characters`));

/** The caption: line breaks allowed, up to 2.200 characters; a blank one is the same as none. */
export const ContentCaptionSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string().refine((value) => characterCount(value) <= CONTENT_CAPTION_MAX_LENGTH, `must be at most ${CONTENT_CAPTION_MAX_LENGTH} characters`))
  .transform((value) => (value === '' ? null : value));

const MediaAssetIdsSchema = z.array(z.string().uuid()).max(CONTENT_CAROUSEL_MAX_MEDIA);

/**
 * Body of `POST .../contents`. The state is not a field: a content is born in production, and `ownerUserId`
 * defaults to who creates it.
 */
export const CreateContentRequestSchema = z.object({
  title: ContentTitleSchema,
  platform: ContentPlatformSchema.optional(),
  format: ContentFormatSchema,
  publishOn: CalendarDaySchema,
  publishAtTime: ContentTimeSchema.nullable().optional(),
  caption: ContentCaptionSchema.nullable().optional(),
  folderId: z.string().uuid(),
  coverAssetId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().optional()
}).strict();

/**
 * Body of `PATCH .../contents/:contentId`: any subset, and moving the date is just `publishOn`. `ownerUserId`
 * is a separate permission, and `mediaAssetIds` is the whole ordered list (never a delta), written in the same
 * transaction as the format so one request changes both.
 */
export const UpdateContentRequestSchema = z.object({
  title: ContentTitleSchema.optional(),
  format: ContentFormatSchema.optional(),
  publishOn: CalendarDaySchema.optional(),
  publishAtTime: ContentTimeSchema.nullable().optional(),
  caption: ContentCaptionSchema.nullable().optional(),
  folderId: z.string().uuid().optional(),
  coverAssetId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().optional(),
  mediaAssetIds: MediaAssetIdsSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

/** `from` and `to`, both inclusive: the same query as the story scripts' period, so the two cannot drift. */
export const ContentPeriodQuerySchema = StoryScriptPeriodQuerySchema;

/** What is wrong with the bounds of a period, or `undefined`. 93 days counts both ends: 93 passes and 94 does not. */
export const contentPeriodIssue = (query: z.infer<typeof ContentPeriodQuerySchema>): { readonly path: string; readonly message: string } | undefined =>
  storyScriptPeriodIssues(query)[0];

/** One content as the calendar and the feed need it: no caption and no media. */
export const ContentListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  platform: ContentPlatformSchema,
  format: ContentFormatSchema,
  publishOn: z.string(),
  publishAtTime: z.string().nullable(),
  status: ContentStatusSchema,
  ownerUserId: z.string().uuid(),
  coverAssetId: z.string().uuid().nullable(),
  revision: z.number().int().positive(),
  publishedOn: z.string().nullable(),
  tasksTotal: z.number().int().nonnegative(),
  tasksApproved: z.number().int().nonnegative()
}).strict();

export const StoryScriptListItemSchema = z.object({
  id: z.string().uuid(),
  scriptOn: z.string(),
  status: StoryScriptStatusSchema
}).strict();

export const ContentPeriodResponseSchema = z.object({
  data: z.object({
    contents: z.array(ContentListItemSchema),
    storyScripts: z.array(StoryScriptListItemSchema)
  }).strict(),
  meta: z.object({
    from: z.string(),
    to: z.string(),
    count: z.number().int().nonnegative()
  }).strict()
}).strict();

/** One content, every field of the row the agency may read. */
export const ContentSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  title: z.string(),
  platform: ContentPlatformSchema,
  format: ContentFormatSchema,
  publishOn: z.string(),
  publishAtTime: z.string().nullable(),
  caption: z.string().nullable(),
  folderId: z.string().uuid(),
  coverAssetId: z.string().uuid().nullable(),
  ownerUserId: z.string().uuid(),
  status: ContentStatusSchema,
  revision: z.number().int().positive(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
  approvedByAgencyReason: z.string().nullable(),
  publishedOn: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string()
}).strict();

export const ContentMediaItemSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive()
}).strict();

/** Read only here: the routes that write a subtask are issue #255. */
export const ContentTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeUserId: z.string().uuid(),
  dueOn: z.string(),
  status: ContentTaskStatusSchema,
  returnComment: z.string().nullable(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: z.string().nullable()
}).strict();

export const ContentConversationSchema = z.object({
  threadId: z.string().uuid().nullable(),
  commentCount: z.number().int().nonnegative(),
  lastCommentAt: z.string().nullable()
}).strict();

export const ContentDetailSchema = ContentSchema.extend({
  media: z.array(ContentMediaItemSchema),
  tasks: z.array(ContentTaskSchema),
  conversation: ContentConversationSchema
}).strict();

export const AgencyClientContentPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  contentId: z.string().uuid()
}).strict();

export type ContentFormat = z.infer<typeof ContentFormatSchema>;
export type ContentStatus = z.infer<typeof ContentStatusSchema>;
export type CreateContentRequest = z.infer<typeof CreateContentRequestSchema>;
export type UpdateContentRequest = z.infer<typeof UpdateContentRequestSchema>;
export type ContentPeriodQuery = z.infer<typeof ContentPeriodQuerySchema>;
export type ContentListItem = z.infer<typeof ContentListItemSchema>;
export type StoryScriptListItem = z.infer<typeof StoryScriptListItemSchema>;
export type ContentPeriodResponse = z.infer<typeof ContentPeriodResponseSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type ContentDetail = z.infer<typeof ContentDetailSchema>;
