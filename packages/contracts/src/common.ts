import { z } from 'zod';

/** A public correlation identifier supplied by an API response. */
export const RequestIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'must be a safe request identifier');

/** Metadata shared by public API responses when a request identifier is available. */
export const ApiResponseMetadataSchema = z.object({
  requestId: RequestIdSchema.optional()
}).strict();

export type RequestId = z.infer<typeof RequestIdSchema>;
export type ApiResponseMetadata = z.infer<typeof ApiResponseMetadataSchema>;
