import { z } from 'zod';

import { utf8ByteLength } from './clients.js';
import { PaginationInputSchema, createPaginatedResponseSchema } from './pagination.js';

/**
 * The product's conversation model (specs/clientes.md sections 3 and 4). A thread hangs off one
 * client and its subject is typed; the agency side is implemented by #128, the portal by #130, and
 * Conteúdo adds a `contentId` subject variant instead of a second conversation table.
 *
 * The state is **derived**, never persisted: a thread is resolved when `resolved_at` exists and is
 * not older than its latest comment, and a new comment reopens it with no write to the thread.
 */

/** The seven fixed brand-study sections a thread may be about (the `personas` section included). */
export const ConversationSectionKeySchema = z.enum([
  'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
]);

export const ThreadSideSchema = z.enum(['agency', 'client']);
export const ThreadStateSchema = z.enum(['open', 'resolved']);

/** A subject is exactly one section or one persona; Conteúdo adds a `contentId` variant here. */
export const ThreadSubjectSchema = z.union([
  z.object({ sectionKey: ConversationSectionKeySchema }).strict(),
  z.object({ personaId: z.string().uuid() }).strict()
]);

/**
 * Line breaks and tabs are part of a comment; every other control character is not (NUL would 500).
 * The limit is in UTF-8 bytes because the `client_thread_comments.body` check is `octet_length`.
 */
const isDisallowedControlCode = (code: number): boolean =>
  code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;

const hasDisallowedControlCharacters = (value: string): boolean =>
  [...value].some((character) => isDisallowedControlCode(character.codePointAt(0) ?? 0));

/** Trimmed, non-empty, at most 5000 UTF-8 bytes. */
export const ThreadCommentBodySchema = z.string()
  .refine((value) => !hasDisallowedControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').refine((value) => utf8ByteLength(value) <= 5000, 'must be at most 5000 bytes'));

/** `POST .../threads`: the subject and the first comment. The side is never in the body. */
export const CreateThreadRequestSchema = z.object({
  subject: ThreadSubjectSchema,
  body: ThreadCommentBodySchema
}).strict();

export const CreateThreadCommentRequestSchema = z.object({
  body: ThreadCommentBodySchema
}).strict();

/**
 * A comment's author, read through the comment's own side: the agency membership when `side` is
 * `agency`, the client membership when it is `client`. Never `auth."user"` by a loose id, so an
 * author with no tie to this client/agency is reported as `null` instead of leaking a name.
 */
export const ThreadCommentAuthorSchema = z.object({
  name: z.string(),
  photoUrl: z.string().nullable()
}).strict();

export const ThreadCommentSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  side: ThreadSideSchema,
  author: ThreadCommentAuthorSchema.nullable(),
  createdAt: z.string()
}).strict();

export const ThreadOpenedBySchema = z.object({
  name: z.string().nullable(),
  side: ThreadSideSchema
}).strict();

export const ThreadLastCommentSchema = z.object({
  side: ThreadSideSchema,
  at: z.string(),
  excerpt: z.string()
}).strict();

export const ThreadResolvedBySchema = z.object({ name: z.string().nullable() }).strict();

/** One thread in the agency list. `state` is derived; `subject` is the typed subject. */
export const ThreadListItemSchema = z.object({
  id: z.string().uuid(),
  subject: ThreadSubjectSchema,
  state: ThreadStateSchema,
  openedBy: ThreadOpenedBySchema,
  lastComment: ThreadLastCommentSchema.nullable(),
  commentCount: z.number().int().nonnegative(),
  resolvedBy: ThreadResolvedBySchema.nullable(),
  resolvedAt: z.string().nullable()
}).strict();

export const ThreadListResponseSchema = createPaginatedResponseSchema(ThreadListItemSchema);
export const ThreadCommentListResponseSchema = createPaginatedResponseSchema(ThreadCommentSchema);

/** `POST .../threads` answers with the thread and its first comment (specs/clientes.md section 6). */
export const CreateThreadResponseSchema = z.object({
  thread: ThreadListItemSchema,
  comment: ThreadCommentSchema
}).strict();

/**
 * Thread list query: exactly one of `sectionKey`/`personaId` is required, but that rule is enforced
 * in the handler (400) so this stays a plain object the OpenAPI registry accepts as query params.
 */
export const ThreadListQuerySchema = PaginationInputSchema.extend({
  sectionKey: ConversationSectionKeySchema.optional(),
  personaId: z.string().uuid().optional(),
  state: ThreadStateSchema.optional()
}).strict();

export type ConversationSectionKey = z.infer<typeof ConversationSectionKeySchema>;
export type ThreadSide = z.infer<typeof ThreadSideSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type ThreadSubject = z.infer<typeof ThreadSubjectSchema>;
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;
export type CreateThreadCommentRequest = z.infer<typeof CreateThreadCommentRequestSchema>;
export type ThreadCommentAuthor = z.infer<typeof ThreadCommentAuthorSchema>;
export type ThreadComment = z.infer<typeof ThreadCommentSchema>;
export type ThreadListItem = z.infer<typeof ThreadListItemSchema>;
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;
export type ThreadCommentListResponse = z.infer<typeof ThreadCommentListResponseSchema>;
export type CreateThreadResponse = z.infer<typeof CreateThreadResponseSchema>;
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>;
