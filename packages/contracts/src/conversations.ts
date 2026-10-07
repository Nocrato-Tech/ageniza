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

/** What a thread is about: one of the seven fixed sections, or one persona. Exactly one. */
export const ThreadSubjectSchema = z.union([
  z.object({ sectionKey: BrandSectionKeySchema }).strict(),
  z.object({ personaId: z.string().uuid() }).strict()
]);

/**
 * A comment is trimmed, not empty, and at most 5000 UTF-8 bytes -- the cap the column enforces, so a
 * long accented text is a 400 here and never a 500 from the `octet_length` check. Tab, LF and CR are
 * line breaks a person types; every other control character is refused.
 */
export const CommentBodySchema = z.string()
  .refine((value) => !hasForbiddenControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').refine((value) => utf8ByteLength(value) <= 5000, 'must be at most 5000 bytes'));

export const CreateThreadRequestSchema = z.object({
  subject: ThreadSubjectSchema,
  body: CommentBodySchema
}).strict();

export const CreateCommentRequestSchema = z.object({
  body: CommentBodySchema
}).strict();

/**
 * Query of both thread listings: one subject, named by exactly one of `sectionKey` and `personaId`
 * (a listing across subjects does not exist), and an optional `state`. `PaginationInputSchema` owns
 * `page` and `pageSize`. It stays a plain strict object so the generated documentation can list
 * each parameter; the "exactly one subject" rule is `threadSubjectOfQuery`, which every listing
 * route calls right after validating.
 */
export const ThreadListQuerySchema = PaginationInputSchema.extend({
  sectionKey: BrandSectionKeySchema.optional(),
  personaId: z.string().uuid().optional(),
  state: ThreadStateSchema.optional()
}).strict();

/** The one subject a listing names, or `undefined` when it names none or both. */
export const threadSubjectOfQuery = (query: z.infer<typeof ThreadListQuerySchema>): ThreadSubject | undefined => {
  if (query.sectionKey !== undefined && query.personaId === undefined) return { sectionKey: query.sectionKey };
  if (query.personaId !== undefined && query.sectionKey === undefined) return { personaId: query.personaId };
  return undefined;
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
  subject: ThreadSubjectSchema,
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
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>;
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;
export type ThreadComment = z.infer<typeof CommentSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;
export type CommentListResponse = z.infer<typeof CommentListResponseSchema>;
