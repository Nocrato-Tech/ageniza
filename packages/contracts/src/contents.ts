import { z } from 'zod';

import { isCalendarDay, utf8ByteLength } from './clients.js';
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

/** The earliest day a content is planned or published on: no real post is older, and `0001-01-01` is a typo that the calendar cannot show. */
export const CONTENT_DAY_FLOOR = '2000-01-01';

/** A day of the calendar a content is planned or published on: real, and not before `CONTENT_DAY_FLOOR`. */
export const ContentDaySchema = CalendarDaySchema.refine((day) => day >= CONTENT_DAY_FLOOR, `must not be before ${CONTENT_DAY_FLOOR}`);

/** Body of the moves that take none (submit, unpublish, cancel): a body that carries anything is a 400, not ignored. */
export const ContentMoveRequestSchema = z.object({}).strict();

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
 * A collaborator of the agency as a content names them (the person in charge, who a subtask is for): the link (the only id of a
 * collaborator the API exposes) and the name the link carries. `null` where the person has no link to the agency (an Owner who holds
 * the agency by ownership alone). No route of Conteúdo gives the user id of anyone.
 */
export const ContentPersonSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string()
}).strict();

/**
 * Who approved, without an id: the name and the side they approved from. `agency` is an approval outside the platform (or of a subtask),
 * `client` is the one of a person of the client's portal, who has no link with the agency to name them by.
 */
export const ContentApproverSchema = z.object({
  name: z.string(),
  side: z.enum(['agency', 'client']),
  /**
   * `true` when a person of the client approved through the link of the e-mail "conteúdos para aprovar" (issue #712), as an access with
   * no login. Present only then: an approval in the portal, outside the platform or of a subtask carries no such field.
   */
  viaLink: z.literal(true).optional()
}).strict();

/**
 * Body of `POST .../contents`. The state is not a field: a content is born in production, and the person in charge
 * (`ownerMembershipId`, an active link of a collaborator of the agency) defaults to who creates it.
 */
export const CreateContentRequestSchema = z.object({
  title: ContentTitleSchema,
  platform: ContentPlatformSchema.optional(),
  format: ContentFormatSchema,
  publishOn: ContentDaySchema,
  publishAtTime: ContentTimeSchema.nullable().optional(),
  caption: ContentCaptionSchema.nullable().optional(),
  folderId: z.string().uuid(),
  coverAssetId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().optional()
}).strict();

/**
 * Body of `PATCH .../contents/:contentId`: any subset, and moving the date is just `publishOn`. `ownerMembershipId`
 * is a separate permission, and `mediaAssetIds` is the whole ordered list (never a delta), written in the same
 * transaction as the format so one request changes both.
 */
export const UpdateContentRequestSchema = z.object({
  title: ContentTitleSchema.optional(),
  format: ContentFormatSchema.optional(),
  publishOn: ContentDaySchema.optional(),
  publishAtTime: ContentTimeSchema.nullable().optional(),
  caption: ContentCaptionSchema.nullable().optional(),
  folderId: z.string().uuid().optional(),
  coverAssetId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  mediaAssetIds: MediaAssetIdsSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

/** The column of the reason of an approval outside the platform holds up to 5000 bytes. */
export const CONTENT_REASON_MAX_BYTES = 5_000;
/** `contents.revision` is an `integer`: a larger number would reach the database as an overflow, never as a stale revision. */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** The reason of an approval outside the platform: the one rule of free text, trimmed, never empty, bounded in bytes. */
export const ContentReasonSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string()
    .min(1, 'must not be empty')
    .refine((value) => utf8ByteLength(value) <= CONTENT_REASON_MAX_BYTES, `must be at most ${CONTENT_REASON_MAX_BYTES} bytes`));

/**
 * Body of `POST .../approve-by-agency`: the revision the person read (a caption edited since is refused, not approved
 * unseen) and the reason. Who approved and when are fixed by the database, never fields of the body.
 */
export const ApproveContentByAgencyRequestSchema = z.object({
  revision: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  reason: ContentReasonSchema
}).strict();

/** Body of `POST .../publish`: the real day of the publication, today in America/Sao_Paulo when absent; never in the future. */
export const PublishContentRequestSchema = z.object({
  publishedOn: ContentDaySchema.optional()
}).strict();

/** Body of `POST .../reschedule`: the new day of a cancelled content, the day it had when absent. */
export const RescheduleContentRequestSchema = z.object({
  publishOn: ContentDaySchema.optional()
}).strict();

/** `from` and `to`, both inclusive: the same query as the story scripts' period, so the two cannot drift. */
export const ContentPeriodQuerySchema = StoryScriptPeriodQuerySchema;

/** What is wrong with the bounds of a period, or `undefined`. 93 days counts both ends: 93 passes and 94 does not. */
export const contentPeriodIssue = (query: z.infer<typeof ContentPeriodQuerySchema>): { readonly path: string; readonly message: string } | undefined =>
  storyScriptPeriodIssues(query)[0];

/** One content as the calendar and the feed need it: no caption and no media. `thumbnailAssetId` is the file that serves as its cover: the chosen cover, else the first media, else null. */
export const ContentListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  platform: ContentPlatformSchema,
  format: ContentFormatSchema,
  publishOn: z.string(),
  publishAtTime: z.string().nullable(),
  status: ContentStatusSchema,
  owner: ContentPersonSchema.nullable(),
  coverAssetId: z.string().uuid().nullable(),
  thumbnailAssetId: z.string().uuid().nullable(),
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
  owner: ContentPersonSchema.nullable(),
  status: ContentStatusSchema,
  revision: z.number().int().positive(),
  approvedBy: ContentApproverSchema.nullable(),
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

/** One subtask of a content, as the agency reads it: the detail of a content and every route of a subtask answer with it. */
export const ContentTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  assignee: ContentPersonSchema.nullable(),
  dueOn: z.string(),
  status: ContentTaskStatusSchema,
  returnComment: z.string().nullable(),
  approvedBy: ContentApproverSchema.nullable(),
  approvedAt: z.string().nullable()
}).strict();

/** A content holds up to 50 subtasks, whatever their state: the 51st is refused (decision of the maestro, issue #255). */
export const CONTENT_TASKS_MAX_PER_CONTENT = 50;

/** The column of the description of a subtask holds up to 20000 bytes; its title follows the content's (one line, 120 characters). */
export const CONTENT_TASK_DESCRIPTION_MAX_BYTES = 20_000;

/** A blank description is the same as none, like a caption. */
export const ContentTaskDescriptionSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string().refine((value) => utf8ByteLength(value) <= CONTENT_TASK_DESCRIPTION_MAX_BYTES, `must be at most ${CONTENT_TASK_DESCRIPTION_MAX_BYTES} bytes`))
  .transform((value) => (value === '' ? null : value));

/**
 * Body of `POST .../contents/:contentId/tasks`. The person in charge is a link (`assigneeMembershipId`), never a user id, and the
 * state is not a field: a subtask is born pending and moves only through deliver, approve and return.
 */
export const CreateContentTaskRequestSchema = z.object({
  title: ContentTitleSchema,
  description: ContentTaskDescriptionSchema.nullable().optional(),
  assigneeMembershipId: z.string().uuid(),
  dueOn: CalendarDaySchema
}).strict();

/** Body of `PATCH .../tasks/:taskId`: any subset of what a subtask carries, never its state. */
export const UpdateContentTaskRequestSchema = z.object({
  title: ContentTitleSchema.optional(),
  description: ContentTaskDescriptionSchema.nullable().optional(),
  assigneeMembershipId: z.string().uuid().optional(),
  dueOn: CalendarDaySchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

/** Body of `POST .../tasks/:taskId/return`: the comment the person in charge of the subtask reads, by the rule of the reason (5000 bytes). */
export const ReturnContentTaskRequestSchema = z.object({
  comment: ContentReasonSchema
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

export const AgencyClientContentTaskPathParamsSchema = AgencyClientContentPathParamsSchema.extend({
  taskId: z.string().uuid()
}).strict();

export type ContentFormat = z.infer<typeof ContentFormatSchema>;
export type ContentStatus = z.infer<typeof ContentStatusSchema>;
export type CreateContentRequest = z.infer<typeof CreateContentRequestSchema>;
export type UpdateContentRequest = z.infer<typeof UpdateContentRequestSchema>;
export type ApproveContentByAgencyRequest = z.infer<typeof ApproveContentByAgencyRequestSchema>;
export type PublishContentRequest = z.infer<typeof PublishContentRequestSchema>;
export type RescheduleContentRequest = z.infer<typeof RescheduleContentRequestSchema>;
export type ContentPeriodQuery = z.infer<typeof ContentPeriodQuerySchema>;
export type ContentListItem = z.infer<typeof ContentListItemSchema>;
export type StoryScriptListItem = z.infer<typeof StoryScriptListItemSchema>;
export type ContentPeriodResponse = z.infer<typeof ContentPeriodResponseSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type ContentDetail = z.infer<typeof ContentDetailSchema>;
export type ContentTask = z.infer<typeof ContentTaskSchema>;
export type CreateContentTaskRequest = z.infer<typeof CreateContentTaskRequestSchema>;
export type UpdateContentTaskRequest = z.infer<typeof UpdateContentTaskRequestSchema>;
export type ReturnContentTaskRequest = z.infer<typeof ReturnContentTaskRequestSchema>;
