import { z } from 'zod';

import { characterCount } from './display-name.js';
import { hasInvisibleCharacters } from './invisible-characters.js';

/** The two media categories a content takes: a photo or a video (#21). A content never holds a PDF, an audio or a logo. */
export const MediaCategorySchema = z.enum(['image', 'video']);

/**
 * The five types of a client's media library (decision 2026-11-11): the two a content takes and the files of support. A logo is an
 * image the agency marks as one (`asLogo` at the upload), and the only home of an SVG.
 */
export const MediaLibraryCategorySchema = z.enum(['image', 'video', 'pdf', 'audio', 'logo']);

/** What the column `file_name` holds at most: characters, not bytes. */
export const MEDIA_FILE_NAME_MAX_LENGTH = 255;
export const MEDIA_ALT_TEXT_MAX_LENGTH = 500;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The line and paragraph separators (U+2028, U+2029) are not controls, and they break a line as a line feed does.
const isOneReadableLine = (value: string): boolean =>
  !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) && !hasInvisibleCharacters(value) && !LONE_SURROGATE.test(value);

/**
 * The name a person gives a file: a label, never a path and never part of the object key. One line of at most 255 characters, with no
 * separator of a folder, no control, bidi or invisible character, and not only dots. The database CHECK `media_assets_file_name_shape`
 * holds the same rule for a caller that skips the route.
 */
export const MediaFileNameSchema = z.string()
  .trim()
  .min(1, 'must not be empty')
  .max(MEDIA_FILE_NAME_MAX_LENGTH * 2)
  .refine((value) => characterCount(value) <= MEDIA_FILE_NAME_MAX_LENGTH, `must be at most ${MEDIA_FILE_NAME_MAX_LENGTH} characters`)
  .refine((value) => !/[\\/]/.test(value), 'must be a file name, not a path')
  .refine((value) => !/^\.+$/.test(value), 'must not be only dots')
  .refine(isOneReadableLine, 'must not contain control, bidi or invisible characters');

/** The alternative text of a media: up to 500 characters of one line; blank is the same as none. */
export const MediaAltTextSchema = z.string()
  .trim()
  .max(MEDIA_ALT_TEXT_MAX_LENGTH * 2)
  .refine((value) => characterCount(value) <= MEDIA_ALT_TEXT_MAX_LENGTH, `must be at most ${MEDIA_ALT_TEXT_MAX_LENGTH} characters`)
  .refine(isOneReadableLine, 'must be one line without control, bidi or invisible characters')
  .transform((value) => (value === '' ? null : value));

/** `POST /agencies/:agencyId/media/uploads` request body. The declared size and content type are
 * never trusted for validation; they only pick single-part vs. multipart and the initial category
 * check. The server-side `HeadObject` after upload is what actually enforces limits (issue #21), and
 * the bytes are read at the confirmation: a type that is not the declared one is rejected. */
export const CreateMediaUploadRequestSchema = z.object({
  fileName: MediaFileNameSchema,
  contentType: z.string().trim().min(1).max(256),
  declaredSizeBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024),
  // An image (PNG, JPEG, WebP) is a logo only when the agency says so, and an SVG is accepted only as one.
  asLogo: z.boolean().optional(),
  // A media of a client is born in one of that client's folders: both or neither, and the server
  // checks that the folder is the client's (specs/conteudo.md §3).
  clientId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional()
}).strict().superRefine((value, context) => {
  if ((value.clientId === undefined) !== (value.folderId === undefined)) {
    context.addIssue({ code: 'custom', path: [value.clientId === undefined ? 'clientId' : 'folderId'], message: 'clientId and folderId are sent together' });
  }
});

const SingleUploadSchema = z.object({
  type: z.literal('single'),
  url: z.string().url(),
  expiresAt: z.string().datetime()
}).strict();

const MultipartUploadSchema = z.object({
  type: z.literal('multipart'),
  uploadId: z.string().min(1),
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive()
}).strict();

export const CreateMediaUploadResponseSchema = z.object({
  assetId: z.string().uuid(),
  objectKey: z.string().min(1),
  category: MediaLibraryCategorySchema,
  upload: z.discriminatedUnion('type', [SingleUploadSchema, MultipartUploadSchema])
}).strict();

/** `POST /agencies/:agencyId/media/uploads/:assetId/parts` request body. Re-requestable so a
 * dropped connection can resume: a client re-asks only for the part numbers it still needs. */
export const RequestMediaUploadPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100).superRefine((parts, context) => {
    if (new Set(parts).size !== parts.length) context.addIssue({ code: 'custom', message: 'partNumbers must be unique' });
  })
}).strict();

export const RequestMediaUploadPartsResponseSchema = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().min(1),
    url: z.string().url()
  }).strict()),
  expiresAt: z.string().datetime()
}).strict();

const CompletedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  eTag: z.string().min(1).max(1_024)
}).strict();

/** `POST /agencies/:agencyId/media/uploads/:assetId/complete` request body. `parts` is required
 * for a multipart upload and must be absent for a single-part one. */
export const CompleteMediaUploadRequestSchema = z.object({
  parts: z.array(CompletedPartSchema).min(1).max(10_000).superRefine((parts, context) => {
    if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) {
      context.addIssue({ code: 'custom', message: 'part numbers must be unique' });
    }
  }).optional()
}).strict();

export const CompleteMediaUploadResponseSchema = z.object({
  assetId: z.string().uuid(),
  status: z.literal('confirmed'),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1)
}).strict();

/** `GET /agencies/:agencyId/media/:assetId/download-url` query: which variant to sign. */
export const MediaDownloadUrlQuerySchema = z.object({
  variant: z.enum(['original', 'thumbnail', 'preview']).optional().default('original')
}).strict();

/** `GET /agencies/:agencyId/media/:assetId/download-url`: a short-lived signed GET, issued only
 * at social-publish time (issue #21 scope), never cached or reused past its expiry. */
export const MediaDownloadUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime()
}).strict();

export type MediaCategory = z.infer<typeof MediaCategorySchema>;
export type MediaLibraryCategory = z.infer<typeof MediaLibraryCategorySchema>;
export type CreateMediaUploadRequest = z.infer<typeof CreateMediaUploadRequestSchema>;
export type CreateMediaUploadResponse = z.infer<typeof CreateMediaUploadResponseSchema>;
export type RequestMediaUploadPartsRequest = z.infer<typeof RequestMediaUploadPartsRequestSchema>;
export type RequestMediaUploadPartsResponse = z.infer<typeof RequestMediaUploadPartsResponseSchema>;
export type CompleteMediaUploadRequest = z.infer<typeof CompleteMediaUploadRequestSchema>;
export type CompleteMediaUploadResponse = z.infer<typeof CompleteMediaUploadResponseSchema>;
export type MediaDownloadUrlQuery = z.infer<typeof MediaDownloadUrlQuerySchema>;
export type MediaDownloadUrlResponse = z.infer<typeof MediaDownloadUrlResponseSchema>;
