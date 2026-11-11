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

/** Body of the moves that take none (unpublish, cancel): a body that carries anything is a 400, not ignored. Submit has its own, `SubmitContentRequestSchema`. */
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
 * (`ownerMembershipId`, an active link of a collaborator of the agency) defaults to who creates it. The media is what the
 * folder holds and the format takes (newest first) unless `mediaAssetIds` names the whole ordered list.
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
  ownerMembershipId: z.string().uuid().optional(),
  mediaAssetIds: MediaAssetIdsSchema.optional()
}).strict();

/**
 * Body of `PATCH .../contents/:contentId`: any subset, and moving the date is just `publishOn`. `ownerMembershipId`
 * is a separate permission, and `mediaAssetIds` is the whole ordered list (never a delta), written in the same
 * transaction as the format so one request changes both. A new `folderId` replaces the list and the cover by what the new
 * folder holds, or by `mediaAssetIds` when the same request names it.
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

/** The note to the client is counted in characters, as the column's check counts them. */
export const APPROVAL_NOTE_MAX_CHARACTERS = 500;
/** One batch sends up to 30 contents of one client. */
export const APPROVAL_BATCH_MAX_CONTENTS = 30;
/** The deadline the send dialog proposes: 48 hours after the send. It is the screen's default; the API accepts a send without a deadline. */
export const APPROVAL_DEFAULT_DEADLINE_HOURS = 48;
/** A deadline lies after now and up to 90 days ahead; the database refuses any other (A0120). */
export const APPROVAL_DEADLINE_MAX_DAYS = 90;

/**
 * The note that goes with a content sent for approval: the one rule of free text (no control, bidi or invisible character, no lone
 * surrogate), trimmed, never blank, at most 500 characters. A blank one is a 400 here as it is A0068 in the database; leave it out to send none.
 */
export const ApprovalNoteSchema = visibleText()
  .transform((value) => value.trim())
  .pipe(z.string()
    .min(1, 'must not be empty')
    .refine((value) => characterCount(value) <= APPROVAL_NOTE_MAX_CHARACTERS, `must be at most ${APPROVAL_NOTE_MAX_CHARACTERS} characters`));

/** The deadline of a round as an instant, with its offset (`2026-11-12T18:00:00-03:00`, or the same moment in UTC); the answers carry it in UTC. */
export const ApprovalDueAtSchema = z.string().datetime({ offset: true });

const oneDeadline = (value: { readonly dueAt?: string | undefined; readonly dueOn?: string | undefined }): boolean =>
  value.dueAt === undefined || value.dueOn === undefined;
const ONE_DEADLINE_ISSUE = { message: 'give the deadline as dueAt, or as dueOn (the end of that day in São Paulo), not both', path: ['dueAt'] };

/**
 * Body of `POST .../contents/:contentId/submit`: the deadline and the note of the round are optional, and `{}` stays valid. The deadline is
 * `dueAt`, an instant (decision 2026-11-11: data e hora); `dueOn`, the day the screens used to send, stays until they migrate and means
 * the end of that day in São Paulo (23:59). Only the format is checked here; that the deadline lies after now and up to 90 days ahead is
 * the database's rule (A0120). `ContentMoveRequestSchema` is not this one: cancel and unpublish still take no field.
 */
export const SubmitContentRequestSchema = z.object({
  dueAt: ApprovalDueAtSchema.optional(),
  dueOn: CalendarDaySchema.optional(),
  note: ApprovalNoteSchema.optional()
}).strict().refine(oneDeadline, ONE_DEADLINE_ISSUE);

/** Body of `POST .../clients/:clientId/contents/submit`: 1 to 30 distinct contents of one client, sent together as one batch, all or none. */
export const SubmitContentsBatchRequestSchema = z.object({
  contentIds: z.array(z.string().uuid())
    .min(1, 'at least one content must be provided')
    .max(APPROVAL_BATCH_MAX_CONTENTS, `at most ${APPROVAL_BATCH_MAX_CONTENTS} contents`)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'must not repeat a content'),
  dueAt: ApprovalDueAtSchema.optional(),
  dueOn: CalendarDaySchema.optional(),
  note: ApprovalNoteSchema.optional()
}).strict().refine(oneDeadline, ONE_DEADLINE_ISSUE);

/**
 * The round a content was sent in, as the agency reads it: when, until when and the note. `null` for a content with no round (still in
 * production, or sent before the rounds existed, which have neither date nor note); inside an object, `dueAt`, `dueOn` and `note` are `null` when
 * none was given. `dueAt` is the deadline (an instant); `dueOn` is the São Paulo day of that instant.
 */
export const ContentApprovalSchema = z.object({
  sentAt: z.string().datetime(),
  dueAt: z.string().datetime().nullable(),
  dueOn: z.string().nullable(),
  note: z.string().nullable()
}).strict();

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
  tasksApproved: z.number().int().nonnegative(),
  approval: ContentApprovalSchema.nullable()
}).strict();

/** The phone beside the calendar reads the client's feed nine posts a page, three rows of its grid. */
export const CONTENT_FEED_PAGE_SIZE = 9;
/** A cursor is a short opaque token; anything longer is not one this API made. */
export const CONTENT_FEED_CURSOR_MAX_LENGTH = 200;

/** Where the next page of the feed starts: the post it follows, by the three keys of the feed's order. `time` is `HH:MM:SS`, `24:00:00` for a post with none (the last of its day). */
export interface ContentFeedPosition {
  readonly publishOn: string;
  readonly time: string;
  readonly id: string;
}

const FEED_CURSOR_TIME = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?$|^24:00:00$/;
const FEED_CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The token for a position: base64url of a JSON triple. The server makes it and the client sends it back untouched. */
export const encodeContentFeedCursor = (position: ContentFeedPosition): string =>
  btoa(JSON.stringify([position.publishOn, position.time, position.id])).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** The position a token names, or `undefined` when it is not one this API made (never throws). */
export const decodeContentFeedCursor = (cursor: string): ContentFeedPosition | undefined => {
  if (cursor.length === 0 || cursor.length > CONTENT_FEED_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const parsed: unknown = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [publishOn, time, id] = parsed as unknown[];
    if (typeof publishOn !== 'string' || typeof time !== 'string' || typeof id !== 'string') return undefined;
    if (!isCalendarDay(publishOn) || !FEED_CURSOR_TIME.test(time) || !FEED_CURSOR_ID.test(id)) return undefined;
    return { publishOn, time, id };
  } catch {
    return undefined;
  }
};

/** `cursor` is absent for the first page, and the `nextCursor` of the previous one after that. A malformed one is a 400. */
export const ContentFeedQuerySchema = z.object({
  cursor: z.string().refine((value) => decodeContentFeedCursor(value) !== undefined, 'must be a cursor returned by this endpoint').optional()
}).strict();

export const ContentFeedResponseSchema = z.object({
  data: z.object({
    contents: z.array(ContentListItemSchema),
    /** `null` on the last page. */
    nextCursor: z.string().nullable(),
    /** Over the whole feed of the client (the same filter as the grid), not over the page. Only the first page (no `cursor`) carries them; every other page has `null`, and the reader keeps what the first one said. */
    counters: z.object({
      posts: z.number().int().nonnegative(),
      approved: z.number().int().nonnegative(),
      awaitingApproval: z.number().int().nonnegative()
    }).strict().nullable()
  }).strict(),
  meta: z.object({ count: z.number().int().nonnegative() }).strict()
}).strict();

/** When a step of the path was taken and the name that goes with it, as the Início says "Feito, <name>, <date>". The screen turns the instant into a São Paulo day, or "agora" within the hour. */
export const ActivationStepSchema = z.object({
  at: z.string().datetime(),
  name: z.string()
}).strict();

/**
 * What the agency's Início reads to show the activation path: the four facts and, for each step already taken, its date and a name
 * (decision 2026-11-11). Each step is `null` when it was not taken, or when the data that would date it does not exist (a content sent
 * before the rounds existed has no send date) or may not be read by this person. `firstSent.name` is the first active person of the
 * client's portal, read only with `cliente.convidar_usuario`, and the name of the client otherwise; `firstSent.others` counts the
 * other active people ("e mais N"; 0 when the person may not read them).
 */
export const ContentActivationResponseSchema = z.object({
  data: z.object({
    hasContent: z.boolean(),
    sentForApproval: z.boolean(),
    approvedByClient: z.boolean(),
    published: z.boolean(),
    steps: z.object({
      firstClient: ActivationStepSchema.nullable(),
      firstContent: ActivationStepSchema.nullable(),
      firstSent: ActivationStepSchema.extend({ others: z.number().int().nonnegative() }).strict().nullable(),
      firstApproved: ActivationStepSchema.nullable()
    }).strict()
  }).strict()
}).strict();

/**
 * The counters of the agency's Início: "Esperando", "Atrasados", "Aprovados no mês" with the month before, and "Agendados" with the day of
 * the last one (decisions 2026-11-11). Over the contents the person reads (`conteudo.visualizar`) of the agency's active clients.
 * "Atrasados" are the ones awaiting the client whose publication day (São Paulo) passed. "Aprovados no mês" counts the approved and
 * published contents by the São Paulo day of the approval, in the month of today and in the month before (today's count of each: not a
 * history). "Agendados" are approved contents with an hour whose publication instant has not passed (`contentIsScheduled`).
 */
export const ContentSummaryResponseSchema = z.object({
  data: z.object({
    awaitingClient: z.number().int().nonnegative(),
    overdueAwaitingClient: z.number().int().nonnegative(),
    approvedThisMonth: z.number().int().nonnegative(),
    approvedLastMonth: z.number().int().nonnegative(),
    scheduled: z.object({
      count: z.number().int().nonnegative(),
      /** The publication day of the last scheduled content; `null` when there is none. */
      lastPublishOn: z.string().nullable()
    }).strict()
  }).strict()
}).strict();

/** The summary of "Parado no cliente" holds at most 50 contents in all, and says it was cut (`meta.truncated`) when there were more. */
export const AWAITING_CLIENT_MAX_CONTENTS = 50;

/** The most people of a client's portal the summary names: past that, the screen has no use for another name. */
export const AWAITING_CLIENT_MAX_APPROVERS = 50;

/**
 * A content that waits for the client, as the Início of the agency lists it. `daysWaiting` (since `sentAt`), `daysToDue` (until `dueOn`, the
 * São Paulo day of the deadline, negative once it passed) and `daysLate` (since the publication day, when that day passed) are days in São
 * Paulo, counted by the server; each is `null` when its date is, and `daysLate` also when the publication day has not passed. A content
 * sent before the rounds has neither a send date nor a deadline. `dueAt` is the deadline of the approval as an instant, not the day of the
 * publication. `thumbnailAssetId` is the file that serves as its cover.
 */
export const AwaitingClientContentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  format: ContentFormatSchema,
  publishOn: z.string(),
  thumbnailAssetId: z.string().uuid().nullable(),
  sentAt: z.string().datetime().nullable(),
  dueAt: z.string().datetime().nullable(),
  dueOn: z.string().nullable(),
  daysWaiting: z.number().int().nonnegative().nullable(),
  daysToDue: z.number().int().nullable(),
  daysLate: z.number().int().positive().nullable()
}).strict();

/**
 * `GET /agencies/:agencyId/contents/awaiting-client`: a summary block grouped by client, no pagination, no query, from the content sent
 * longest ago to the newest (`sentAt`; one with no send date comes last, by its publication day). The clients follow the order of the first
 * content of each. `approvers` names, in the order they were given the access, the active people of the client's portal who have entered it
 * (names only: no e-mail, id or role); it is `null` for a person without `cliente.convidar_usuario`, who sees the client alone.
 */
export const AwaitingClientResponseSchema = z.object({
  data: z.array(z.object({
    clientId: z.string().uuid(),
    clientName: z.string(),
    approvers: z.array(z.string()).max(AWAITING_CLIENT_MAX_APPROVERS).nullable(),
    contents: z.array(AwaitingClientContentSchema).min(1).max(AWAITING_CLIENT_MAX_CONTENTS)
  }).strict()),
  meta: z.object({ truncated: z.boolean() }).strict()
}).strict();

/** Answer of the batch send: the batch and each content as the list reads it, now awaiting approval, all of one client. */
export const SubmitContentsBatchResponseSchema = z.object({
  data: z.object({
    batchId: z.string().uuid(),
    contents: z.array(ContentListItemSchema).min(1).max(APPROVAL_BATCH_MAX_CONTENTS)
  }).strict()
}).strict();

/** A script in the calendar: its day, its state (`recorded` is "gravado") and how many scenes it has. */
export const StoryScriptListItemSchema = z.object({
  id: z.string().uuid(),
  scriptOn: z.string(),
  status: StoryScriptStatusSchema,
  sceneCount: z.number().int().nonnegative()
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
  createdAt: z.string(),
  approval: ContentApprovalSchema.nullable()
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
export type SubmitContentRequest = z.infer<typeof SubmitContentRequestSchema>;
export type SubmitContentsBatchRequest = z.infer<typeof SubmitContentsBatchRequestSchema>;
export type SubmitContentsBatchResponse = z.infer<typeof SubmitContentsBatchResponseSchema>;
export type ContentApproval = z.infer<typeof ContentApprovalSchema>;
export type AwaitingClientContent = z.infer<typeof AwaitingClientContentSchema>;
export type AwaitingClientResponse = z.infer<typeof AwaitingClientResponseSchema>;
export type ApproveContentByAgencyRequest = z.infer<typeof ApproveContentByAgencyRequestSchema>;
export type PublishContentRequest = z.infer<typeof PublishContentRequestSchema>;
export type RescheduleContentRequest = z.infer<typeof RescheduleContentRequestSchema>;
export type ContentPeriodQuery = z.infer<typeof ContentPeriodQuerySchema>;
export type ContentListItem = z.infer<typeof ContentListItemSchema>;
export type StoryScriptListItem = z.infer<typeof StoryScriptListItemSchema>;
export type ContentFeedResponse = z.infer<typeof ContentFeedResponseSchema>;
export type ContentActivationResponse = z.infer<typeof ContentActivationResponseSchema>;
export type ContentSummaryResponse = z.infer<typeof ContentSummaryResponseSchema>;
export type ContentPeriodResponse = z.infer<typeof ContentPeriodResponseSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type ContentDetail = z.infer<typeof ContentDetailSchema>;
export type ContentTask = z.infer<typeof ContentTaskSchema>;
export type CreateContentTaskRequest = z.infer<typeof CreateContentTaskRequestSchema>;
export type UpdateContentTaskRequest = z.infer<typeof UpdateContentTaskRequestSchema>;
export type ReturnContentTaskRequest = z.infer<typeof ReturnContentTaskRequestSchema>;
