import { z } from 'zod';

import { ApiResponseMetadataSchema } from './common.js';

/** Public, stable details about a failed API operation. Keep details safe for clients. */
export const ApiErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.unknown().optional()
}).strict();

/** Standard public error response shape for application API endpoints. */
export const ApiErrorResponseSchema = z.object({
  error: ApiErrorSchema,
  meta: ApiResponseMetadataSchema.optional()
}).strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
