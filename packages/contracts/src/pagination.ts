import { z } from 'zod';

/** Optional page controls. Endpoints own defaults and maximum page sizes. */
export const PaginationInputSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional()
}).strict();

/** Page-based metadata returned alongside a public collection response. */
export const PaginationMetadataSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative()
}).strict();

/** Builds the standard shape for a paginated public response without coupling it to a domain entity. */
export const createPaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) => z.object({
  data: z.array(itemSchema),
  meta: PaginationMetadataSchema
}).strict();

export type PaginationInput = z.infer<typeof PaginationInputSchema>;
export type PaginationMetadata = z.infer<typeof PaginationMetadataSchema>;
export type PaginatedResponse<TItemSchema extends z.ZodTypeAny> = z.infer<
  ReturnType<typeof createPaginatedResponseSchema<TItemSchema>>
>;
