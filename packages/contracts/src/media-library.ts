import { z } from 'zod';

import { ContentPersonSchema, ContentStatusSchema } from './contents.js';
import { MediaFolderNameSchema, MediaFolderSchema } from './media-folders.js';
import { MediaAltTextSchema, MediaFileNameSchema, MediaLibraryCategorySchema } from './media.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * The media library of a client, agency side (decisions 2026-11-11 "a mídia ganha nome, dimensões, texto alternativo, renomear e
 * mover", "a mídia aceita PDF, áudio e SVG como logo" and "a mídia mostra onde é usada"): every confirmed file of the client across its
 * folders, with the name, the dimensions, who uploaded it and where it is used. The storage keys never leave the server.
 */

export const MEDIA_LIBRARY_SEARCH_MAX_LENGTH = 100;

const mediaIdSchema = z.string().uuid();

export const MediaVideoProcessingStatusSchema = z.enum(['not_applicable', 'pending', 'processing', 'ready', 'failed']);

/**
 * `name` and the dimensions are `null` for a media uploaded before they were kept (the screen shows the label of the type), and the
 * dimensions are also `null` for a PDF, an audio and an SVG, and for a video whose processing has not finished. `uploadedBy` is `null`
 * for a person with no link to the agency. `usageCount` is the number of contents (as a media or as the cover) the reader can see.
 */
export const MediaLibraryAssetSchema = z.object({
  id: mediaIdSchema,
  folderId: mediaIdSchema,
  folderName: z.string().min(1),
  category: MediaLibraryCategorySchema,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  name: z.string().min(1).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  altText: z.string().min(1).nullable(),
  videoProcessingStatus: MediaVideoProcessingStatusSchema,
  uploadedBy: ContentPersonSchema.nullable(),
  createdAt: z.string().datetime(),
  usageCount: z.number().int().nonnegative()
}).strict();

export const AgencyClientMediaAssetPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  assetId: z.string().uuid()
}).strict();

const MediaSearchTermSchema = z.string()
  .trim()
  .max(MEDIA_LIBRARY_SEARCH_MAX_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters');

/**
 * `GET .../clients/:clientId/media`: the files of the client newest first, across folders (the "enviados recentemente" table of the
 * client). `q` filters by the name, ignoring case and accents; a blank `q` is no filter.
 */
export const MediaLibraryListQuerySchema = PaginationInputSchema.extend({
  q: MediaSearchTermSchema.optional(),
  category: MediaLibraryCategorySchema.optional(),
  folderId: mediaIdSchema.optional()
}).strict();
export const MediaLibraryListResponseSchema = createPaginatedResponseSchema(MediaLibraryAssetSchema);

/**
 * `PATCH .../media/:assetId`: any subset of the two fields a person edits. The name is a label (the key of the object never changes);
 * a blank or `null` `altText` clears it.
 */
export const UpdateMediaAssetRequestSchema = z.object({
  name: MediaFileNameSchema.optional(),
  altText: MediaAltTextSchema.nullable().optional()
}).strict().refine((value) => value.name !== undefined || value.altText !== undefined, 'name or altText must be sent');

/** `POST .../media/:assetId/move`: another folder of the same client. */
export const MoveMediaAssetRequestSchema = z.object({
  folderId: mediaIdSchema
}).strict();

/** A content that holds the file, as the reader may see it: its title and state, and whether it uses it as a media or as the cover. */
export const MediaUsageSchema = z.object({
  contentId: mediaIdSchema,
  title: z.string(),
  status: ContentStatusSchema,
  asMedia: z.boolean(),
  asCover: z.boolean()
}).strict();

export const MediaUsageListQuerySchema = PaginationInputSchema;
export const MediaUsageListResponseSchema = createPaginatedResponseSchema(MediaUsageSchema);

export const MediaFolderTypeCountsSchema = z.object({
  image: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
  pdf: z.number().int().nonnegative(),
  audio: z.number().int().nonnegative(),
  logo: z.number().int().nonnegative()
}).strict();

/**
 * A folder with what it holds (decision 2026-11-11): the files by type, their total size, the last time something changed in it
 * (the folder's own creation or a file written in it) and who uploaded the newest file. A read derived from the files; no column of
 * the folder holds it. `inUseNow` is true for at most one folder of the client, the one the "em uso agora" block of the screen shows: the
 * folder that is not a default one whose files were written most recently (an upload, a rename, a move into it), when that was in the last
 * 30 days. No folder is in use when none qualifies, and the screen leaves the block out.
 */
export const MediaFolderSummarySchema = MediaFolderSchema.extend({
  counts: MediaFolderTypeCountsSchema,
  assetCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  lastChangedAt: z.string().datetime(),
  lastUploadedBy: ContentPersonSchema.nullable(),
  inUseNow: z.boolean()
}).strict();

export const MediaFolderSummaryListQuerySchema = PaginationInputSchema;
export const MediaFolderSummaryListResponseSchema = createPaginatedResponseSchema(MediaFolderSummarySchema);

/** `PATCH .../media-folders/:folderId`: the name of a folder of the client. The four default folders are not renamed. */
export const RenameMediaFolderRequestSchema = z.object({
  name: MediaFolderNameSchema
}).strict();

export type MediaLibraryAsset = z.infer<typeof MediaLibraryAssetSchema>;
export type MediaLibraryListQuery = z.infer<typeof MediaLibraryListQuerySchema>;
export type UpdateMediaAssetRequest = z.infer<typeof UpdateMediaAssetRequestSchema>;
export type MoveMediaAssetRequest = z.infer<typeof MoveMediaAssetRequestSchema>;
export type MediaUsage = z.infer<typeof MediaUsageSchema>;
export type MediaFolderSummary = z.infer<typeof MediaFolderSummarySchema>;
export type RenameMediaFolderRequest = z.infer<typeof RenameMediaFolderRequestSchema>;
