import { z } from 'zod';

import { MediaFileNameSchema } from './media.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { ClientThreadPathParamsSchema } from './params.js';

/**
 * Material the client sends through the portal (decision 2026-11-11 "o cliente envia material pelo portal"): photos and audio, to a request
 * for material that is open, in the folder "Enviados pelo cliente" of the client. The upload runs the cycle of the agency's (initiate, a
 * direct PUT, complete) in a single part, and the keys of the storage never leave the server.
 *
 * The ceilings and the accepted types are written in the database too (`app_private.portal_upload_max_bytes`, `portal_upload_max_files`
 * and `portal_upload_type`, migration 20261113000100), which is what refuses them; the integration test of that migration reads these
 * constants, so the two copies cannot drift apart.
 */

export const PORTAL_MATERIAL_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const PORTAL_MATERIAL_UPLOAD_MAX_FILES = 20;
export const PORTAL_MATERIAL_UPLOAD_FOLDER_NAME = 'Enviados pelo cliente';

export const PortalMaterialUploadCategorySchema = z.enum(['image', 'audio']);

/** An image or an audio, never an SVG, a video or a PDF. The parameters of a type (`audio/webm;codecs=opus`) are not part of it. */
export const PORTAL_MATERIAL_UPLOAD_TYPES = {
  'image/png': { category: 'image', extension: 'png' },
  'image/jpeg': { category: 'image', extension: 'jpg' },
  'image/webp': { category: 'image', extension: 'webp' },
  'image/gif': { category: 'image', extension: 'gif' },
  'audio/mpeg': { category: 'audio', extension: 'mp3' },
  'audio/mp4': { category: 'audio', extension: 'm4a' },
  'audio/x-m4a': { category: 'audio', extension: 'm4a' },
  'audio/wav': { category: 'audio', extension: 'wav' },
  'audio/x-wav': { category: 'audio', extension: 'wav' },
  'audio/wave': { category: 'audio', extension: 'wav' },
  'audio/webm': { category: 'audio', extension: 'webm' },
  'audio/ogg': { category: 'audio', extension: 'ogg' }
} as const;

export type PortalMaterialUploadContentType = keyof typeof PORTAL_MATERIAL_UPLOAD_TYPES;

/**
 * What the database records, and answers the portal, when it turns the bytes of a finished upload down (`rejected_reason`). The portal never
 * learns the plan or the storage of the agency (decision 2026-11-11, item 5): when the agency has no room, the reason is `agency_unavailable`,
 * as the start of the upload answers it with the neutral A0136.
 */
export const PortalMaterialUploadRejectionReasonSchema = z.enum([
  'empty_object',
  'content_type_mismatch',
  'too_large',
  'invalid_dimensions',
  'request_full',
  'agency_unavailable'
]);

/** The path of the request is `ClientThreadPathParamsSchema`; the file adds its identifier. */
export const ClientMaterialRequestUploadAssetPathParamsSchema = ClientThreadPathParamsSchema.extend({
  assetId: z.string().uuid()
});

/**
 * `POST /clients/:clientId/material-requests/:threadId/uploads` request body, like the agency's: the declared type and size are never
 * trusted, the database refuses a type outside the list and a size above the ceiling (413), and the bytes are read at the completion.
 */
export const CreatePortalMaterialUploadRequestSchema = z.object({
  fileName: MediaFileNameSchema,
  contentType: z.string().trim().min(1).max(256),
  declaredSizeBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024)
}).strict();

export const CreatePortalMaterialUploadResponseSchema = z.object({
  assetId: z.string().uuid(),
  category: PortalMaterialUploadCategorySchema,
  contentType: z.string().min(1),
  upload: z.object({
    type: z.literal('single'),
    url: z.string().url(),
    expiresAt: z.string().datetime()
  }).strict()
}).strict();

/** `POST .../uploads/:assetId/complete`: no body, the object is read from the storage. */
export const CompletePortalMaterialUploadRequestSchema = z.object({}).strict();

export const CompletePortalMaterialUploadResponseSchema = z.object({
  assetId: z.string().uuid(),
  status: z.literal('confirmed'),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1)
}).strict();

/**
 * A file the person sent to the request: pending while the object is on its way, confirmed once the bytes were read. `sizeBytes` is the
 * declared size of a pending one and the real size of a confirmed one.
 */
export const PortalMaterialUploadSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'confirmed']),
  category: PortalMaterialUploadCategorySchema,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  name: z.string().min(1).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  createdAt: z.string().datetime()
}).strict();

export const PortalMaterialUploadListQuerySchema = PaginationInputSchema;
export const PortalMaterialUploadListResponseSchema = createPaginatedResponseSchema(PortalMaterialUploadSchema);

export type PortalMaterialUploadCategory = z.infer<typeof PortalMaterialUploadCategorySchema>;
export type PortalMaterialUploadRejectionReason = z.infer<typeof PortalMaterialUploadRejectionReasonSchema>;
export type ClientMaterialRequestUploadAssetPathParams = z.infer<typeof ClientMaterialRequestUploadAssetPathParamsSchema>;
export type CreatePortalMaterialUploadRequest = z.infer<typeof CreatePortalMaterialUploadRequestSchema>;
export type CreatePortalMaterialUploadResponse = z.infer<typeof CreatePortalMaterialUploadResponseSchema>;
export type CompletePortalMaterialUploadResponse = z.infer<typeof CompletePortalMaterialUploadResponseSchema>;
export type PortalMaterialUpload = z.infer<typeof PortalMaterialUploadSchema>;
export type PortalMaterialUploadListResponse = z.infer<typeof PortalMaterialUploadListResponseSchema>;
