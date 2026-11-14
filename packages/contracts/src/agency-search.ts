import { z } from 'zod';

import { ContentFormatSchema, ContentStatusSchema } from './contents.js';
import { MediaLibraryCategorySchema } from './media.js';
import { SearchTextSchema } from './search.js';

/**
 * The search of the agency's top bar (specs/busca.md sections 3, 5 and 6; decision 2026-11-11): a client, a content or a file found by
 * name, in three groups. Everything here is `.strict()`. The term is a name that may be a client's, so a refusal of it never carries the
 * value back: the issues name the field and the rule only.
 */

export const AGENCY_SEARCH_TERM_MIN_LENGTH = 2;
export const AGENCY_SEARCH_TERM_MAX_LENGTH = 80;

/** At most this many of each group; whoever wants more refines the term (decision 2026-11-11, item 4). */
export const AGENCY_SEARCH_GROUP_LIMIT = 6;

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * What of the term is searched for: without the accents, which the database folds away, and without a leading `@` that marks the handle
 * field and is not a character searched. The minimum of `AGENCY_SEARCH_TERM_MIN_LENGTH` counts this, not what was typed, so the route and
 * the screen share one rule: `@a` and a lone accent are below it. A lone `@` stays, as the search does not drop it.
 */
export const searchedCharacters = (term: string): string => {
  const folded = term.normalize('NFD').replace(COMBINING_MARKS, '');
  return folded.startsWith('@') && folded.length > 1 ? folded.slice(1) : folded;
};

export const AgencySearchQuerySchema = z.object({
  q: SearchTextSchema.min(AGENCY_SEARCH_TERM_MIN_LENGTH).max(AGENCY_SEARCH_TERM_MAX_LENGTH)
}).strict();

/** `photoUrl` is a signed read URL or null, never a key; `archived` marks a client who is no longer active. */
export const AgencySearchClientSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  instagramHandle: z.string().nullable(),
  archived: z.boolean()
}).strict();

/**
 * A content found by its title, cancelled ones included (`status` says so). `overdue` and `scheduled` are the two derived states of
 * Conteúdo (`contentDeadline` and `contentIsScheduled`), read at the same instant as the day of São Paulo.
 */
export const AgencySearchContentSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  title: z.string(),
  format: ContentFormatSchema,
  status: ContentStatusSchema,
  overdue: z.boolean(),
  scheduled: z.boolean(),
  publishOn: z.string()
}).strict();

/** A confirmed, not removed file found by its name. `thumbnailAssetId` is the file itself when it has a picture to show, else null. */
export const AgencySearchFileSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  folderId: z.string().uuid(),
  name: z.string(),
  category: MediaLibraryCategorySchema,
  thumbnailAssetId: z.string().uuid().nullable()
}).strict();

/** The three groups are always present: a group the person cannot read is `[]`, the same as a group with nothing found. */
export const AgencySearchResponseSchema = z.object({
  data: z.object({
    clients: z.array(AgencySearchClientSchema).max(AGENCY_SEARCH_GROUP_LIMIT),
    contents: z.array(AgencySearchContentSchema).max(AGENCY_SEARCH_GROUP_LIMIT),
    files: z.array(AgencySearchFileSchema).max(AGENCY_SEARCH_GROUP_LIMIT)
  }).strict(),
  meta: z.object({ q: z.string() }).strict()
}).strict();

export type AgencySearchQuery = z.infer<typeof AgencySearchQuerySchema>;
export type AgencySearchClient = z.infer<typeof AgencySearchClientSchema>;
export type AgencySearchContent = z.infer<typeof AgencySearchContentSchema>;
export type AgencySearchFile = z.infer<typeof AgencySearchFileSchema>;
export type AgencySearchResponse = z.infer<typeof AgencySearchResponseSchema>;
