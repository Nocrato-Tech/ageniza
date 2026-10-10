import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createDisplayNameSchema } from './display-name.js';
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
export const hasForbiddenControlCharacters = (value: string): boolean => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export const utf8ByteLength = (value: string): number => {
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

/** Trimmed; an empty or whitespace-only value is stored as null, never as ''. */
const nullableTrimmedText = (maxBytes: number) =>
  boundedText(maxBytes)
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value))
    .nullable();

/**
 * A nullable display name: empty or whitespace-only becomes null, and the value must satisfy the
 * shared display-name rule (#200). The byte cap is what the column checks, because a character
 * cap alone would let a multibyte name reach the database and surface as a 500.
 */
const nullableDisplayText = (maxChars: number, maxBytes: number) =>
  z.string()
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value))
    .pipe(z.union([
      z.null(),
      createDisplayNameSchema(maxChars).refine((value) => utf8ByteLength(value) <= maxBytes, `must be at most ${maxBytes} bytes`)
    ]))
    .nullable();

/** ZWJ/ZWNJ between two Latin letters (marks allowed before the joiner) only forge a lookalike of another name. */
const JOINER_BETWEEN_LATIN_LETTERS = /(?<=\p{Script=Latin}\p{M}*)[‌‍]+(?=\p{Script=Latin})/u;

/**
 * Invisible or blank characters the shared rule lets through because they are not `\p{Cf}`: the
 * combining grapheme joiner (U+034F, `Mn`), the variation selectors (U+180B-U+180D, U+FE00-U+FE0F, VS16 included,
 * U+E0100-U+E01EF), the Khmer inherent vowels (U+17B4, U+17B5), the tag characters and the like are
 * all `Default_Ignorable_Code_Point`, and the Braille blank (U+2800, `So`) renders as a space. The
 * unique index removes none of them, so each one forges a homonym of an active name. ZWJ/ZWNJ are
 * `Default_Ignorable` too but are decided separately (shared rule + the Latin check below).
 */
const INVISIBLE_IN_CLIENT_NAME = /(?![\u200C\u200D])[\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * A client name carries no emoji (owner decision of 2026-10-08): every `Extended_Pictographic`
 * character is refused, which also closes the homonyms an emoji could forge -- a redundant VS16
 * after a default-emoji pictograph, and a ZWJ between a pictograph and a letter or another
 * pictograph, both render exactly like the plain name. VS16 itself stays refused by the invisible
 * characters rule below. The copyright, registered and trademark signs (U+00A9, U+00AE, U+2122)
 * are the owner's exception: they are common in a company name. Being pictographic, they would
 * still let the shared rule accept a joiner beside them, so `JOINER_NEXT_TO_MARK_SIGN` closes it.
 */
const PICTOGRAPH_IN_CLIENT_NAME = /(?![©®™])\p{Extended_Pictographic}/u;
const JOINER_NEXT_TO_MARK_SIGN = /[©®™][‌‍]|[‌‍][©®™]/u;

/**
 * Client name: the shared display-name rule (control, bidi and invisible characters rejected, at
 * least one letter or number) plus the 256-byte cap the column and the unique index enforce --
 * "Padaria Central" followed by a zero-width space must not create a visually identical homonym.
 * The stored form is NFC with every `\p{Zs}` space as a plain space, because the unique index only
 * folds case and `[[:space:]]` runs: a decomposed "Cafe" + U+0301 or a U+2007 gap would otherwise
 * be a different key for a name that looks the same.
 */
export const ClientNameSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .transform((value) => value.normalize('NFC').replace(/\p{Zs}/gu, ' '))
  .pipe(createDisplayNameSchema(256))
  .refine((value) => !JOINER_BETWEEN_LATIN_LETTERS.test(value), 'a zero-width joiner is not allowed between Latin letters')
  .refine((value) => !PICTOGRAPH_IN_CLIENT_NAME.test(value), 'must not contain emoji or pictographs')
  .refine((value) => !JOINER_NEXT_TO_MARK_SIGN.test(value), 'a zero-width joiner is not allowed next to a mark sign')
  .refine((value) => !INVISIBLE_IN_CLIENT_NAME.test(value), 'must not contain invisible or blank characters')
  .refine((value) => utf8ByteLength(value) <= 256, 'must be at most 256 bytes');

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

/**
 * Body of `PATCH /agencies/:agencyId/clients/:clientId`; an absent key leaves the field alone.
 * An empty body would only touch `updated_by`, so at least one field is required.
 */
export const UpdateClientRequestSchema = z.object({
  name: ClientNameSchema.optional(),
  legalName: nullableDisplayText(256, 256).optional(),
  taxId: ClientTaxIdSchema.nullable().optional(),
  segment: nullableTrimmedText(120).optional(),
  website: ClientWebsiteSchema.nullable().optional(),
  instagramHandle: ClientInstagramHandleSchema.nullable().optional(),
  contactName: nullableDisplayText(256, 256).optional(),
  contactPhone: nullableDisplayText(32, 32).optional(),
  contactEmail: ClientContactEmailSchema.nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'at least one field must be provided');

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real day of the Gregorian calendar ('2026-02-30' and year 0000 are not), in the shape the `date` column prints. */
const isCalendarDay = (value: string): boolean => {
  const parts = CALENDAR_DAY.exec(value);
  if (parts === null) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (year < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

/**
 * Body of `PUT .../clients/:clientId/closing`: the last day of the contract. That the day is today
 * or later in `America/Sao_Paulo` is the database's rule (`app_private.set_client_closing_date`),
 * so the route and the daily job never keep two clocks.
 */
export const SetClientClosingRequestSchema = z.object({
  closingDate: z.string().refine(isCalendarDay, 'closingDate must be a real date in the form YYYY-MM-DD')
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
export type SetClientClosingRequest = z.infer<typeof SetClientClosingRequestSchema>;
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

// --- Portal reads (specs/clientes.md sections 2, 6 and 7) ----------------------------------------

/** Neither portal read takes a query parameter; the empty strict object makes an undeclared one a 400. */
export const PortalClientQuerySchema = z.object({}).strict();

/** The Início summary: what the portal's next action is built from (specs/clientes.md section 6). */
export const PortalHomeSchema = z.object({
  /** Open threads whose latest comment is the agency's, on subjects the portal can read. */
  threadsAnsweredByAgency: z.number().int().nonnegative(),
  brandStudyFilled: z.number().int().min(0).max(7)
}).strict();

/**
 * `GET /clients/:clientId`: the client's own registration, read-only, plus what the portal header
 * and the tour need. `status` and `archivedAt` are pinned because the portal never reaches an
 * archived client, so a row that was would fail to parse instead of being served.
 */
export const PortalClientResponseSchema = z.object({
  ...ClientSchema.shape,
  status: z.literal('active'),
  archivedAt: z.null(),
  agencyName: z.string(),
  /** When the caller's own link saw the tour; never another person's of the same client. */
  onboardingSeenAt: z.string().nullable(),
  home: PortalHomeSchema
}).strict();

/** A section as the portal reads it: the same as the agency's, without who edited it internally. */
export const PortalBrandStudySectionSchema = BrandStudySectionSchema.omit({ updatedBy: true });

/** An active persona; an archived one is not served, and the literal makes a leak fail to parse. */
export const PortalPersonaSchema = PersonaSchema.omit({ updatedBy: true }).extend({ status: z.literal('active') });

export const PortalBrandStudyResponseSchema = z.object({
  filled: z.number().int().min(0).max(7),
  sections: z.array(PortalBrandStudySectionSchema),
  personas: z.array(PortalPersonaSchema)
}).strict();

export type PortalHome = z.infer<typeof PortalHomeSchema>;
export type PortalClientResponse = z.infer<typeof PortalClientResponseSchema>;
export type PortalBrandStudySection = z.infer<typeof PortalBrandStudySectionSchema>;
export type PortalPersona = z.infer<typeof PortalPersonaSchema>;
export type PortalBrandStudyResponse = z.infer<typeof PortalBrandStudyResponseSchema>;

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
