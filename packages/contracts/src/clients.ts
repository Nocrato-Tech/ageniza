import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { PROFILE_PHOTO_MAX_BASE64_LENGTH } from './profile.js';
import { SearchTextSchema } from './search.js';

/**
 * Client (specs/clientes.md section 3). `name` is the only required field and the only one a POST
 * accepts; a PATCH may send any subset of the registration fields, and `null` clears one.
 *
 * Free text rejects control characters before anything reaches the database: a NUL byte makes
 * PostgreSQL reject the statement with a 500, and no field here has a legitimate use for one.
 * Single-line fields (names, phone, website...) reject every control range, while the multiline
 * fields (brand-study text and persona text) allow tab, LF and CR, which are line breaks a person
 * actually types. Lengths are checked in UTF-8 bytes, not UTF-16 units, because that is what the
 * column checks enforce (`octet_length`).
 */
// eslint-disable-next-line no-control-regex -- the control range is exactly what must be rejected.
const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

// Tab (U+0009), LF (U+000A) and CR (U+000D) are allowed; every other C0 control and DEL is not.
// eslint-disable-next-line no-control-regex -- the forbidden range is exactly what must be rejected.
const hasForbiddenControlCharacters = (value: string): boolean => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

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

/** Multiline free text: tab, LF and CR are line breaks, every other control character is rejected. */
const boundedMultilineText = (maxBytes: number) =>
  z.string()
    .refine((value) => !hasForbiddenControlCharacters(value), 'must not contain control characters')
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

/**
 * `PUT .../photo` body: the image base64-encoded in JSON, the transport issue #100 chose for every
 * identity asset (the profile photo uses it too). There is no declared content type and no key:
 * the type is sniffed from the bytes and the object key is built from server-validated ids only.
 */
export const UploadClientPhotoRequestSchema = z.object({
  imageBase64: z.string().min(1).max(PROFILE_PHOTO_MAX_BASE64_LENGTH).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be a base64-encoded image')
}).strict();

export const UploadClientPhotoResponseSchema = z.object({
  photoUrl: z.string().url()
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
export type UploadClientPhotoRequest = z.infer<typeof UploadClientPhotoRequestSchema>;
export type UploadClientPhotoResponse = z.infer<typeof UploadClientPhotoResponseSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type ClientSummary = z.infer<typeof ClientSummarySchema>;
export type ClientDetailResponse = z.infer<typeof ClientDetailResponseSchema>;
export type ClientListSort = z.infer<typeof ClientListSortSchema>;
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;
export type ClientListItem = z.infer<typeof ClientListItemSchema>;
export type ClientListResponse = z.infer<typeof ClientListResponseSchema>;


// --- Brand study (specs/clientes.md section 3) ----------------------------------------------

/** The seven fixed sections. There is no route that creates a section. */
export const BrandSectionKeySchema = z.enum([
  'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'personas', 'observations'
]);

/** The six keys a `PUT` accepts; `personas` is the table below and is not writable as a section. */
export const WritableBrandSectionKeySchema = z.enum([
  'branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'observations'
]);

/**
 * The twelve archetypes: the key is the contract value, the label is what the database stores and
 * the frontend shows. The English key is what a request sends and a response returns.
 */
export const ArchetypeSchema = z.enum([
  'innocent', 'sage', 'explorer', 'outlaw', 'magician', 'hero',
  'lover', 'jester', 'everyman', 'caregiver', 'ruler', 'creator'
]);

export const ARCHETYPE_LABELS: Readonly<Record<z.infer<typeof ArchetypeSchema>, string>> = Object.freeze({
  innocent: 'Inocente',
  sage: 'Sábio',
  explorer: 'Explorador',
  outlaw: 'Fora-da-lei',
  magician: 'Mago',
  hero: 'Herói',
  lover: 'Amante',
  jester: 'Bobo da corte',
  everyman: 'Cara comum',
  caregiver: 'Cuidador',
  ruler: 'Governante',
  creator: 'Criador'
});

export const BrandColorSchema = z.object({
  name: boundedText(60),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'hex must be #RRGGBB')
}).strict();

/**
 * Text sections: trimmed, non-empty, at most 20000 UTF-8 bytes. Multiline: tab, LF and CR are
 * accepted and returned unchanged. Whitespace-only is rejected because `filled` counts only
 * `btrim(body) <> ''`.
 */
export const BrandSectionTextSchema = z.string()
  .refine((value) => !hasForbiddenControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').refine((value) => utf8ByteLength(value) <= 20000, 'must be at most 20000 bytes'));

/** `PUT` body, one shape per writable key. `strict()` rejects a field of another section. */
export const BrandStudySectionUpdateRequestSchema = z.union([
  z.object({ body: BrandSectionTextSchema }).strict(),
  z.object({ colors: z.array(BrandColorSchema).max(24) }).strict(),
  z.object({ archetype: ArchetypeSchema }).strict()
]);

/** Trimmed, non-empty, at most 120 UTF-8 bytes. */
export const PersonaNameSchema = z.string()
  .refine((value) => !hasControlCharacters(value), 'must not contain control characters')
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must not be empty').refine((value) => utf8ByteLength(value) <= 120, 'must be at most 120 bytes'));

export const CreatePersonaRequestSchema = z.object({
  name: PersonaNameSchema,
  description: boundedMultilineText(5000).nullable().optional(),
  pains: boundedMultilineText(5000).nullable().optional(),
  desires: boundedMultilineText(5000).nullable().optional(),
  objections: boundedMultilineText(5000).nullable().optional()
}).strict();

/** A PATCH with no field would only touch `updated_by`; an empty body is refused instead. */
export const UpdatePersonaRequestSchema = z.object({
  name: PersonaNameSchema.optional(),
  description: boundedMultilineText(5000).nullable().optional(),
  pains: boundedMultilineText(5000).nullable().optional(),
  desires: boundedMultilineText(5000).nullable().optional(),
  objections: boundedMultilineText(5000).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

/** Who last saved a section or persona, resolved through the agency membership, never `auth."user"` alone. */
export const BrandStudyUpdatedBySchema = z.object({
  id: z.string().uuid(),
  name: z.string()
}).strict();

/** One of the seven sections, always present in the response, filled or not. */
export const BrandStudySectionSchema = z.object({
  key: BrandSectionKeySchema,
  body: z.string().nullable(),
  colors: z.array(BrandColorSchema).nullable(),
  archetype: ArchetypeSchema.nullable(),
  updatedBy: BrandStudyUpdatedBySchema.nullable(),
  updatedAt: z.string().nullable()
}).strict();

export const PersonaSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  pains: z.string().nullable(),
  desires: z.string().nullable(),
  objections: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  updatedBy: BrandStudyUpdatedBySchema.nullable(),
  updatedAt: z.string().nullable()
}).strict();

export const BrandStudyResponseSchema = z.object({
  filled: z.number().int().min(0).max(7),
  sections: z.array(BrandStudySectionSchema),
  personas: z.array(PersonaSchema)
}).strict();

export type BrandSectionKey = z.infer<typeof BrandSectionKeySchema>;
export type WritableBrandSectionKey = z.infer<typeof WritableBrandSectionKeySchema>;
export type Archetype = z.infer<typeof ArchetypeSchema>;
export type BrandColor = z.infer<typeof BrandColorSchema>;
export type BrandStudySectionUpdate = z.infer<typeof BrandStudySectionUpdateRequestSchema>;
export type BrandStudyUpdatedBy = z.infer<typeof BrandStudyUpdatedBySchema>;
export type BrandStudySection = z.infer<typeof BrandStudySectionSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequestSchema>;
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequestSchema>;
export type BrandStudyResponse = z.infer<typeof BrandStudyResponseSchema>;
