import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { SearchTextSchema } from './search.js';

/**
 * Client (specs/clientes.md section 3). `name` is the only required field and the only one a POST
 * accepts; a PATCH may send any subset of the registration fields, and `null` clears one.
 *
 * Every free-text field rejects control characters (U+0000..U+001F and U+007F) before anything
 * reaches the database: a NUL byte makes PostgreSQL reject the statement with a 500, and no field
 * here has a legitimate use for a control character. Lengths are checked in UTF-8 bytes, not
 * UTF-16 units, because that is what the `clients` column checks enforce (`octet_length`).
 */
// eslint-disable-next-line no-control-regex -- the control range is exactly what must be rejected.
const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
};

const boundedText = (maxBytes: number) =>
  z.string()
    .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
    .refine((value) => utf8ByteLength(value) <= maxBytes, `must be at most ${maxBytes} bytes`);

/** Trimmed, non-empty and at most 256 UTF-8 bytes -- the same shape the active-name index normalizes. */
export const ClientNameSchema = z.string()
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').refine((value) => utf8ByteLength(value) <= 256, 'must be at most 256 bytes'));

/** Digits only, stored without any mask; 11 or 14 digits. */
export const ClientTaxIdSchema = z.string()
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => value.length === 11 || value.length === 14, 'taxId must have 11 or 14 digits');

/** Instagram handle, stored without the leading `@`. */
export const ClientInstagramHandleSchema = z.string()
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .transform((value) => (value.startsWith('@') ? value.slice(1) : value))
  .refine((value) => /^[A-Za-z0-9._]{1,30}$/.test(value), 'instagramHandle is invalid');

export const ClientWebsiteSchema = z.string()
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .refine((value) => utf8ByteLength(value) <= 2048, 'must be at most 2048 bytes')
  .refine((value) => /^https?:\/\/[^\s]+$/.test(value), 'website must be an http(s) URL');

export const ClientContactEmailSchema = AuthEmailSchema.refine(
  (value) => utf8ByteLength(value) <= 320,
  'must be at most 320 bytes'
);

export const ClientStatusSchema = z.enum(['active', 'archived']);

/** Body of `POST /agencies/:agencyId/clients`: the name, and nothing else. */
export const CreateClientRequestSchema = z.object({
  name: ClientNameSchema
}).strict();

/** Body of `PATCH /agencies/:agencyId/clients/:clientId`; an absent key leaves the field alone. */
export const UpdateClientRequestSchema = z.object({
  name: ClientNameSchema.optional(),
  legalName: boundedText(256).nullable().optional(),
  taxId: ClientTaxIdSchema.nullable().optional(),
  segment: boundedText(120).nullable().optional(),
  website: ClientWebsiteSchema.nullable().optional(),
  instagramHandle: ClientInstagramHandleSchema.nullable().optional(),
  contactName: boundedText(256).nullable().optional(),
  contactPhone: boundedText(32).nullable().optional(),
  contactEmail: ClientContactEmailSchema.nullable().optional()
}).strict();

/** One client, as every route returns it. `photoUrl` is a signed read URL or null, never a key. */
export const ClientSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: ClientStatusSchema,
  photoUrl: z.string().nullable(),
  legalName: z.string().nullable(),
  taxId: z.string().nullable(),
  segment: z.string().nullable(),
  website: z.string().nullable(),
  instagramHandle: z.string().nullable(),
  contactName: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactEmail: z.string().nullable(),
  closingDate: z.string().nullable(),
  archivedAt: z.string().nullable()
}).strict();

/** The General tab summary (specs/clientes.md section 6). */
export const ClientSummarySchema = z.object({
  /** Filled brand-study sections, 0..7; `personas` counts when at least one persona is active. */
  brandStudyFilled: z.number().int().min(0).max(7),
  threadsAwaitingAgency: z.number().int().nonnegative(),
  threadsAnsweredByAgency: z.number().int().nonnegative(),
  activePortalMembers: z.number().int().nonnegative()
}).strict();

/** `GET` detail: the full registration plus the General tab summary. */
export const ClientDetailResponseSchema = z.object({
  ...ClientSchema.shape,
  summary: ClientSummarySchema
}).strict();

/** Ordering of the client listing (SPEC §6): triage first, or plain name ascending. */
export const ClientListSortSchema = z.enum(['attention', 'name:asc']);

/**
 * Query of `GET /agencies/:agencyId/clients` (issue #125). `PaginationInputSchema` owns
 * `page`/`pageSize` (route default of 20, global ceiling of 100 that limits rather than refuses,
 * and the `page` overflow guard); this schema adds only the named filters the SPEC declares.
 * `.strict()` keeps the rule that a parameter the SPEC does not declare does not exist, so an
 * unknown one is a 400 and never silently ignored.
 *
 * `search` uses `SearchTextSchema`, which trims, refuses control characters and caps the length;
 * the accent/case-insensitive matching over name, razão social and @ is the service's job.
 */
export const ClientListQuerySchema = PaginationInputSchema.extend({
  search: SearchTextSchema.optional(),
  status: ClientStatusSchema.optional(),
  sort: ClientListSortSchema.optional()
}).strict();

/**
 * One item of the client listing (SPEC §6): the card's fields plus the triage signal. Only the
 * eight fields the listing promises; the full registration stays on the detail route.
 *
 * `pendingInvitations` is **omitted**, never zeroed, for a caller without
 * `cliente.convidar_usuario`: zero would be a lie the interface would show (issues #125/#134).
 */
export const ClientListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  photoUrl: z.string().nullable(),
  instagramHandle: z.string().nullable(),
  status: ClientStatusSchema,
  closingDate: z.string().nullable(),
  threadsAwaitingAgency: z.number().int().nonnegative(),
  pendingInvitations: z.number().int().nonnegative().optional()
}).strict();

export const ClientListResponseSchema = createPaginatedResponseSchema(ClientListItemSchema);

export type ClientStatus = z.infer<typeof ClientStatusSchema>;
export type CreateClientRequest = z.infer<typeof CreateClientRequestSchema>;
export type UpdateClientRequest = z.infer<typeof UpdateClientRequestSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type ClientSummary = z.infer<typeof ClientSummarySchema>;
export type ClientDetailResponse = z.infer<typeof ClientDetailResponseSchema>;
export type ClientListSort = z.infer<typeof ClientListSortSchema>;
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;
export type ClientListItem = z.infer<typeof ClientListItemSchema>;
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;
