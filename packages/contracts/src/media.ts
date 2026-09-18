import { z } from 'zod';

/** The only two media categories the issue defines limits for (#21). */
export const MediaCategorySchema = z.enum(['image', 'video']);

/** `POST /agencies/:agencyId/media/uploads` request body. The declared size and content type are
 * never trusted for validation; they only pick single-part vs. multipart and the initial category
 * check. The server-side `HeadObject` after upload is what actually enforces limits (issue #21). */
export const CreateMediaUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(256),
  contentType: z.string().trim().min(1).max(256),
  declaredSizeBytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024)
}).strict();

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
  category: MediaCategorySchema,
  upload: z.discriminatedUnion('type', [SingleUploadSchema, MultipartUploadSchema])
}).strict();

/** `POST /agencies/:agencyId/media/uploads/:assetId/parts` request body. Re-requestable so a
 * dropped connection can resume: a client re-asks only for the part numbers it still needs. */
export const RequestMediaUploadPartsRequestSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(10_000)
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
  parts: z.array(CompletedPartSchema).min(1).max(10_000).optional()
}).strict();

export const CompleteMediaUploadResponseSchema = z.object({
  assetId: z.string().uuid(),
  status: z.literal('confirmed'),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1)
}).strict();

/** `GET /agencies/:agencyId/media/:assetId/download-url`: a short-lived signed GET, issued only
 * at social-publish time (issue #21 scope), never cached or reused past its expiry. */
export const MediaDownloadUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime()
}).strict();

export type MediaCategory = z.infer<typeof MediaCategorySchema>;
export type CreateMediaUploadRequest = z.infer<typeof CreateMediaUploadRequestSchema>;
export type CreateMediaUploadResponse = z.infer<typeof CreateMediaUploadResponseSchema>;
export type RequestMediaUploadPartsRequest = z.infer<typeof RequestMediaUploadPartsRequestSchema>;
export type RequestMediaUploadPartsResponse = z.infer<typeof RequestMediaUploadPartsResponseSchema>;
export type CompleteMediaUploadRequest = z.infer<typeof CompleteMediaUploadRequestSchema>;
export type CompleteMediaUploadResponse = z.infer<typeof CompleteMediaUploadResponseSchema>;
export type MediaDownloadUrlResponse = z.infer<typeof MediaDownloadUrlResponseSchema>;
