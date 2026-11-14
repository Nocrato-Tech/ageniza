import { z } from 'zod';

import { BrandSectionKeySchema, createVisibleLineSchema, hasForbiddenControlCharacters, isCalendarDay, utf8ByteLength } from './clients.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { hasHiddenStoryCharacters } from './story-scripts.js';

/**
 * The conversation between an agency and its client (specs/clientes.md sections 3, 4 and 6). The
 * same contract serves both sides: the agency routes (#128) and the portal routes (#130) differ in
 * who may call them and in which side the server stamps, never in the shape.
 *
 * The side of a thread or of a comment is never part of a request: it follows from the route and
 * the credential (rule 10), so every request schema is `.strict()` and a `side` is a 400.
 */

export const ConversationSideSchema = z.enum(['agency', 'client']);

export const ThreadStateSchema = z.enum(['open', 'resolved']);

/** What a brand study thread is about: one of the seven fixed sections, or one persona. Exactly one. */
export const ThreadSubjectSchema = z.union([
  z.object({ sectionKey: BrandSectionKeySchema }).strict(),
  z.object({ personaId: z.string().uuid() }).strict()
]);

/** What a thread of the portal may be about: a brand study subject or, since #259, a content (specs/conteudo.md section 3). */
const ContentOrBrandSubjectSchema = z.union([
  ...ThreadSubjectSchema.options,
  z.object({ contentId: z.string().uuid() }).strict()
]);

/**
 * The request for material the agency makes to a client (decision 2026-11-10, "pedido de material"): a subject of its own, at the level
 * of the client and never inside the conversation of a content. It names no id: a client holds many, each its own thread.
 */
export const MaterialRequestSubjectSchema = z.object({ materialRequest: z.literal(true) }).strict();

/**
 * What any conversation is about: a brand study subject, a content or a request for material. A content has exactly one conversation,
 * so opening it a second time writes into the first; a request for material is always a new thread.
 */
export const ConversationSubjectSchema = z.union([...ContentOrBrandSubjectSchema.options, MaterialRequestSubjectSchema]);

/** Spaces and format characters: a text made only of them says nothing. */
const SPACE_OR_FORMAT = /[\s\p{Cf}]/gu;

/**
 * A comment is trimmed, says something a person can read, and is at most 5000 UTF-8 bytes -- the cap the column enforces,
 * so a long accented text is a 400 here and never a 500 from the `octet_length` check. Its characters follow the one rule
 * of free text of the product, the story script's (`hasHiddenStoryCharacters`): no control, bidi, invisible or format
 * character, except what a complete emoji sequence is written with (#539). A text of spaces
 * alone is empty, as it is for the comment of a request for changes in the database.
 */
export const CommentBodySchema = z.string()
  .refine((value) => !hasForbiddenControlCharacters(value), 'must not contain control characters')
  .refine((value) => !hasHiddenStoryCharacters(value), 'must not contain control or invisible characters')
  .transform((value) => value.trim())
  .pipe(z.string()
    .min(1, 'must not be empty')
    .refine((value) => value.replace(SPACE_OR_FORMAT, '') !== '', 'must not be empty')
    .refine((value) => utf8ByteLength(value) <= 5000, 'must be at most 5000 bytes'));

/** A real day in the form the `date` column prints; the range (today to 90 days ahead, in São Paulo) is the database's. */
const DueOnSchema = z.string().refine(isCalendarDay, 'must be a real date in the form YYYY-MM-DD');

/** The title of a request for material (decision 2026-11-11): one visible line of up to 80 characters. */
export const MATERIAL_REQUEST_TITLE_MAX_LENGTH = 80;
export const MaterialRequestTitleSchema = createVisibleLineSchema(MATERIAL_REQUEST_TITLE_MAX_LENGTH);

/**
 * Body of the route of the agency that opens a thread. `dueOn` is the deadline of a request for material and of nothing else: with any
 * other subject it is a 400, because no other thread has one. The same holds for `title`, and a new request must have one (the ones
 * that were opened before the title existed have none).
 */
export const CreateThreadRequestSchema = z.object({
  subject: ConversationSubjectSchema,
  body: CommentBodySchema,
  title: MaterialRequestTitleSchema.optional(),
  dueOn: DueOnSchema.optional()
}).strict().superRefine((value, context) => {
  const isMaterialRequest = 'materialRequest' in value.subject;
  if (value.dueOn !== undefined && !isMaterialRequest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dueOn'], message: 'only a request for material has a deadline' });
  }
  if (value.title !== undefined && !isMaterialRequest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'only a request for material has a title' });
  }
  if (value.title === undefined && isMaterialRequest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'a request for material needs a title' });
  }
});

/**
 * Body of the route of the portal that opens a thread: the subjects the portal always had. A request for material is the agency's alone
 * (decision 2026-11-10), so `materialRequest` and `dueOn` are a 400 here, before the database is asked.
 */
export const PortalCreateThreadRequestSchema = z.object({
  subject: ContentOrBrandSubjectSchema,
  body: CommentBodySchema
}).strict();

export const CreateCommentRequestSchema = z.object({
  body: CommentBodySchema
}).strict();

/**
 * Query of both thread listings: one subject, named by exactly one of `sectionKey`, `personaId`,
 * `contentId` and `materialRequest=true` (a listing across subjects does not exist), and an optional `state`. `PaginationInputSchema` owns
 * `page` and `pageSize`. It stays a plain strict object so the generated documentation can list
 * each parameter; the "exactly one subject" rule is `threadSubjectOfQuery`, which every listing
 * route calls right after validating.
 */
export const ThreadListQuerySchema = PaginationInputSchema.extend({
  sectionKey: BrandSectionKeySchema.optional(),
  personaId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  /** A query string carries text: only the word `true` names the subject. */
  materialRequest: z.literal('true').optional(),
  state: ThreadStateSchema.optional()
}).strict();

/** The one subject a listing names, or `undefined` when it names none or both. */
export const threadSubjectOfQuery = (query: z.infer<typeof ThreadListQuerySchema>): ConversationSubject | undefined => {
  const named = [query.sectionKey, query.personaId, query.contentId, query.materialRequest].filter((value) => value !== undefined);
  if (named.length !== 1) return undefined;
  if (query.sectionKey !== undefined) return { sectionKey: query.sectionKey };
  if (query.personaId !== undefined) return { personaId: query.personaId };
  if (query.materialRequest !== undefined) return { materialRequest: true };
  return query.contentId === undefined ? undefined : { contentId: query.contentId };
};

/** `PaginationInputSchema` only: comments are listed oldest first, with nothing to filter. */
export const CommentListQuerySchema = PaginationInputSchema;

/**
 * Who wrote a comment, read through the link of the comment's own side. `null` only when that link
 * no longer resolves a name (an agency owner without a membership row); a removed person keeps the
 * name, because the comment is history.
 */
export const CommentAuthorSchema = z.object({
  name: z.string(),
  photoUrl: z.string().nullable()
}).strict();

export const CommentSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  side: ConversationSideSchema,
  author: CommentAuthorSchema.nullable(),
  createdAt: z.string()
}).strict();

export const ThreadSchema = z.object({
  id: z.string().uuid(),
  subject: ConversationSubjectSchema,
  /** Derived, never stored: resolved only while the resolution is newer than the last comment. */
  state: ThreadStateSchema,
  openedBy: z.object({ name: z.string().nullable(), side: ConversationSideSchema }).strict(),
  lastComment: z.object({ side: ConversationSideSchema, at: z.string(), excerpt: z.string() }).strict(),
  commentCount: z.number().int().positive(),
  /** Only the agency resolves; the name is `null` only for an owner with no agency link row to read it from. */
  resolvedBy: z.object({ name: z.string().nullable() }).strict().nullable(),
  resolvedAt: z.string().nullable(),
  /** The deadline of a request for material (`YYYY-MM-DD`); `null` for a request without one and for every other subject. */
  dueOn: z.string().nullable(),
  /** The title of a request for material; `null` for every other subject and for a request opened before the title existed (the screen then uses the start of the text). */
  title: z.string().nullable()
}).strict();

/** `201` of the route that opens a thread: the thread and the first comment, written together. */
export const CreateThreadResponseSchema = z.object({
  thread: ThreadSchema,
  comment: CommentSchema
}).strict();

export const ThreadListResponseSchema = createPaginatedResponseSchema(ThreadSchema);
export const CommentListResponseSchema = createPaginatedResponseSchema(CommentSchema);

/**
 * One request for material as the portal reads it (`GET /clients/:clientId/material-requests`, "A agência pediu" and "Pedidos da agência"):
 * the title (`null` for a request opened before it existed), the text the agency wrote (the first comment of the thread), the deadline and
 * when it was asked. The portal lists the open ones only, so `state` is `open` in practice. It never says who on the agency opened it.
 */
export const MaterialRequestSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().nullable(),
  body: z.string(),
  dueOn: z.string().nullable(),
  createdAt: z.string().datetime(),
  state: ThreadStateSchema
}).strict();

/**
 * "Atrasado" (decision 2026-11-11): the deadline of a request is before `today` and nobody resolved it. `today` is the day in
 * America/Sao_Paulo as `YYYY-MM-DD`, which compares in order as text; the state of the request is the derived one of its thread.
 */
export const isMaterialRequestOverdue = (request: { readonly dueOn: string | null; readonly state: ThreadState }, today: string): boolean =>
  request.state === 'open' && request.dueOn !== null && request.dueOn < today;

/** Only the page controls: the listing names no subject, and it never lists a resolved request. */
export const MaterialRequestListQuerySchema = PaginationInputSchema;
export const MaterialRequestListResponseSchema = createPaginatedResponseSchema(MaterialRequestSchema);

export type ConversationSide = z.infer<typeof ConversationSideSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type ThreadSubject = z.infer<typeof ThreadSubjectSchema>;
export type ConversationSubject = z.infer<typeof ConversationSubjectSchema>;
export type MaterialRequestSubject = z.infer<typeof MaterialRequestSubjectSchema>;
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type PortalCreateThreadRequest = z.infer<typeof PortalCreateThreadRequestSchema>;
export type MaterialRequest = z.infer<typeof MaterialRequestSchema>;
export type MaterialRequestListQuery = z.infer<typeof MaterialRequestListQuerySchema>;
export type MaterialRequestListResponse = z.infer<typeof MaterialRequestListResponseSchema>;
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;
export type ThreadComment = z.infer<typeof CommentSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;
