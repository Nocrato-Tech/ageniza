import { z } from 'zod';

import { createDisplayNameSchema } from './display-name.js';
import { MediaCategorySchema } from './media.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/** The longest name a folder shows. The database CHECK holds 256 bytes, and 80 UTF-16 units are at most 240. */
export const MEDIA_FOLDER_NAME_MAX_LENGTH = 80;

/**
 * What renders as nothing (or as a space) and is not `\p{Cf}`, so the display-name rule lets it through: the combining
 * grapheme joiner (U+034F), the variation selectors and the Khmer vowels are `Default_Ignorable_Code_Point`, and the
 * Braille blank (U+2800) is a symbol. "Imagens" plus one of them looks like the default folder and is not the same name.
 * U+FE0F right after a pictograph is how an emoji such as the heart is written, so that pair stays.
 */
const INVISIBLE_IN_FOLDER_NAME = /[\p{Default_Ignorable_Code_Point}\u2800]/u;
const EMOJI_PRESENTATION_SELECTOR = /(\p{Extended_Pictographic})\uFE0F/gu;

// A folder name keeps the display-name rules (control, bidi and invisible characters, at least one
// letter or number) and refuses the two joiners as well (both are Default_Ignorable): the database CHECK accepts them.
export const MediaFolderNameSchema = createDisplayNameSchema(MEDIA_FOLDER_NAME_MAX_LENGTH)
  .refine((value) => !INVISIBLE_IN_FOLDER_NAME.test(value.replace(EMOJI_PRESENTATION_SELECTOR, '$1')), 'must not contain invisible characters');

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
