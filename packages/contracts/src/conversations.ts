import { z } from 'zod';

import { BrandSectionKeySchema, hasForbiddenControlCharacters, utf8ByteLength } from './clients.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

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

/**
 * What any conversation is about: a brand study subject or, since #259, a content (specs/conteudo.md section 3).
 * A content has exactly one conversation, so opening it a second time writes into the first.
 */
export const ConversationSubjectSchema = z.union([
  ...ThreadSubjectSchema.options,
  z.object({ contentId: z.string().uuid() }).strict()
]);

/** Tab, LF and CR are the line breaks a person types; every other control character, and the line and paragraph separators, is refused. */
const LINE_BREAKS = /[\t\n\r]/g;
const CONTROL_OR_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/**
 * What renders as nothing and is not a format character (`Cf`, which the emoji joiners belong to): the combining grapheme
 * joiner, the variation selectors, the Hangul fillers and the like (`Default_Ignorable_Code_Point`), and the Braille
 * blank. The one exception is VS16 right after a pictograph, which is how a phone writes a heart.
 */
const IGNORABLE_NOT_FORMAT = /(?!\p{Cf})[\p{Default_Ignorable_Code_Point}\u2800]/u;
const EMOJI_PRESENTATION = /(?<=\p{Extended_Pictographic})\uFE0F/gu;
/** Spaces and format characters (zero-width space, joiners, bidi marks, the byte order mark): a text made only of them says nothing. */
const SPACE_OR_FORMAT = /[\s\p{Cf}]/gu;

const hasHiddenCommentCharacters = (value: string): boolean => {
  const withoutLineBreaks = value.replace(LINE_BREAKS, '');
  return CONTROL_OR_SEPARATOR.test(withoutLineBreaks) || IGNORABLE_NOT_FORMAT.test(withoutLineBreaks.replace(EMOJI_PRESENTATION, ''));
};

/**
 * A comment is trimmed, says something a person can read, and is at most 5000 UTF-8 bytes -- the cap the column enforces,
 * so a long accented text is a 400 here and never a 500 from the `octet_length` check. It carries no control character
 * (tab, LF and CR are the line breaks a person types) and no invisible one that is not a format character, and a text of
 * spaces and format characters alone is empty, as it is for the comment of a request for changes in the database.
 */
export const CommentBodySchema = z.string()
  .refine((value) => !hasForbiddenControlCharacters(value), 'must not contain control characters')
  .refine((value) => !hasHiddenCommentCharacters(value), 'must not contain control or invisible characters')
  .transform((value) => value.trim())
  .pipe(z.string()
    .min(1, 'must not be empty')
    .refine((value) => value.replace(SPACE_OR_FORMAT, '') !== '', 'must not be empty')
    .refine((value) => utf8ByteLength(value) <= 5000, 'must be at most 5000 bytes'));

export const CreateThreadRequestSchema = z.object({
  subject: ConversationSubjectSchema,
  body: CommentBodySchema
}).strict();

export const CreateCommentRequestSchema = z.object({
  body: CommentBodySchema
}).strict();

/**
 * Query of both thread listings: one subject, named by exactly one of `sectionKey`, `personaId` and
 * `contentId` (a listing across subjects does not exist), and an optional `state`. `PaginationInputSchema` owns
 * `page` and `pageSize`. It stays a plain strict object so the generated documentation can list
 * each parameter; the "exactly one subject" rule is `threadSubjectOfQuery`, which every listing
 * route calls right after validating.
 */
export const ThreadListQuerySchema = PaginationInputSchema.extend({
  sectionKey: BrandSectionKeySchema.optional(),
  personaId: z.string().uuid().optional(),
  contentId: z.string().uuid().optional(),
  state: ThreadStateSchema.optional()
}).strict();

/** The one subject a listing names, or `undefined` when it names none or both. */
export const threadSubjectOfQuery = (query: z.infer<typeof ThreadListQuerySchema>): ConversationSubject | undefined => {
  const named = [query.sectionKey, query.personaId, query.contentId].filter((value) => value !== undefined);
  if (named.length !== 1) return undefined;
  if (query.sectionKey !== undefined) return { sectionKey: query.sectionKey };
  if (query.personaId !== undefined) return { personaId: query.personaId };
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
  resolvedAt: z.string().nullable()
}).strict();

/** `201` of the route that opens a thread: the thread and the first comment, written together. */
export const CreateThreadResponseSchema = z.object({
  thread: ThreadSchema,
  comment: CommentSchema
}).strict();

export const ThreadListResponseSchema = createPaginatedResponseSchema(ThreadSchema);
export const CommentListResponseSchema = createPaginatedResponseSchema(CommentSchema);

export type ConversationSide = z.infer<typeof ConversationSideSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type ThreadSubject = z.infer<typeof ThreadSubjectSchema>;
export type ConversationSubject = z.infer<typeof ConversationSubjectSchema>;
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;
export type ThreadComment = z.infer<typeof CommentSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;
