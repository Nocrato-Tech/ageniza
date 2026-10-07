import { z } from 'zod';

import { createDisplayNameSchema } from './display-name.js';
import { MediaCategorySchema } from './media.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/** The longest name a folder shows. The database holds 256 bytes, so the schema also counts bytes. */
export const MEDIA_FOLDER_NAME_MAX_LENGTH = 80;
const MEDIA_FOLDER_NAME_MAX_BYTES = 256;

// A folder name keeps the display-name rules (control, bidi and invisible characters, at least one
// letter or number) and refuses the two joiners as well: the database CHECK accepts them.
export const MediaFolderNameSchema = createDisplayNameSchema(MEDIA_FOLDER_NAME_MAX_LENGTH)
  .refine((value) => !/[\u200C\u200D]/u.test(value), 'must not contain a zero-width joiner')
  .refine((value) => new TextEncoder().encode(value).length <= MEDIA_FOLDER_NAME_MAX_BYTES, 'is too long once encoded');

/** `POST /agencies/:agencyId/clients/:clientId/media-folders` request body. A folder is created at the first
 * level (no `parentId`) or inside a first-level folder of the same client. */
export const CreateMediaFolderRequestSchema = z.object({
  name: MediaFolderNameSchema,
  parentId: z.string().uuid().optional()
}).strict();

export const MediaFolderSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string().min(1),
  isDefault: z.boolean(),
  createdAt: z.string().datetime()
}).strict();

export const MediaFolderListQuerySchema = PaginationInputSchema;
export const MediaFolderListResponseSchema = createPaginatedResponseSchema(MediaFolderSchema);

/** A confirmed media of a folder; the storage keys never leave the server. */
export const MediaFolderAssetSchema = z.object({
  id: z.string().uuid(),
  category: MediaCategorySchema,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  videoProcessingStatus: z.enum(['not_applicable', 'pending', 'processing', 'ready', 'failed']),
  createdAt: z.string().datetime()
}).strict();

export const MediaFolderAssetListQuerySchema = PaginationInputSchema;
export const MediaFolderAssetListResponseSchema = createPaginatedResponseSchema(MediaFolderAssetSchema);

export const RemoveMediaAssetResponseSchema = z.object({
  assetId: z.string().uuid(),
  removed: z.literal(true)
}).strict();

export type CreateMediaFolderRequest = z.infer<typeof CreateMediaFolderRequestSchema>;
export type MediaFolder = z.infer<typeof MediaFolderSchema>;
export type MediaFolderAsset = z.infer<typeof MediaFolderAssetSchema>;
