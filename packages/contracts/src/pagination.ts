import { z } from 'zod';

/**
 * Global ceiling on `pageSize` for every listing (specs/autorizacao.md §6, "Teto global de
 * pageSize: 100"). A route's default page size is its own; this ceiling is not.
 */
export const PAGE_SIZE_CEILING = 100;

/**
 * Optional page controls. Endpoints own defaults and maximum page sizes. `.safe()` keeps `page`
 * within `Number.MAX_SAFE_INTEGER`: without it, `z.coerce.number().int()` accepts a value like
 * `1e20` (still mathematically an integer to `Number.isInteger`, just not exactly representable),
 * which then overflows the `OFFSET` computed from it. Rejecting it here, as 400, is cheaper than
 * discovering it as a 500 from every route that multiplies `page` by a page size.
 */
export const PaginationInputSchema = z.object({
  page: z.coerce.number().int().positive().safe().optional(),
  pageSize: z.coerce.number().int().positive().safe().optional()
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

export interface ResolvedPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

/**
 * Normalizes a parsed `PaginationInput` into `page`/`pageSize`/`offset`, applying the route's own
 * default page size (specs/autorizacao.md §6: "Tamanho padrão: declarado por rota") and the shared
 * ceiling above. This is the one place every listing computes its offset, so a fix to the ceiling,
 * to the default-page fallback, or to an overflow guard reaches every route that calls it.
 */
export const resolvePagination = (input: PaginationInput, defaultPageSize: number): ResolvedPagination => {
  const page = input.page ?? 1;
  const pageSize = Math.min(input.pageSize ?? defaultPageSize, PAGE_SIZE_CEILING);
  return { page, pageSize, offset: (page - 1) * pageSize };
};

/** Builds the `meta` block for a resolved page and its total item count. */
export const buildPaginationMetadata = (resolved: ResolvedPagination, totalItems: number): PaginationMetadata => ({
  page: resolved.page,
  pageSize: resolved.pageSize,
  totalItems,
  totalPages: Math.ceil(totalItems / resolved.pageSize)
});

export type PaginationInput = z.infer<typeof PaginationInputSchema>;
export type PaginationMetadata = z.infer<typeof PaginationMetadataSchema>;
export type PaginatedResponse<TItemSchema extends z.ZodTypeAny> = z.infer<
  ReturnType<typeof createPaginatedResponseSchema<TItemSchema>>
>;
