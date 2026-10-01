import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { SearchTextSchema } from './search.js';

/** Access role of a collaborator: the system/agency role that grants authorization. */
export const CollaboratorRoleSchema = z.object({
  key: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256)
}).strict();

/**
 * One collaborator as returned by `GET /agencies/:agencyId/collaborators` (issue #95). The first
 * listing of the product, so `#96` (detail) and `#98` (remove/reactivate) reuse it.
 *
 * Only the six fields the SPEC allows (`specs/colaboradores.md` §3): name, photo and email belong
 * to the global user; job title, role and entry date belong to the membership. Remuneration does
 * not exist in this module and must never appear here.
 *
 * `photoUrl` is a short-lived signed URL (`identity-storage`), or null when the person has no
 * photo: `auth."user".image` holds the storage key, never a public address.
 */
export const CollaboratorSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string().trim().min(1).max(256),
  email: AuthEmailSchema,
  photoUrl: z.string().nullable(),
  jobTitle: z.string().trim().min(1).max(256).nullable(),
  role: CollaboratorRoleSchema,
  isOwner: z.boolean(),
  status: z.enum(['active', 'removed']),
  joinedAt: z.string().datetime()
}).strict();

/**
 * Query of the collaborator listing. `PaginationInputSchema` owns `page`/`pageSize` (default per
 * route, global ceiling of 100 that limits rather than refuses, and the `page` overflow guard);
 * this schema adds only the named filters the SPEC declares (`SPEC §6`, "Listagem"). `.strict()`
 * keeps the rule that a parameter the SPEC does not declare does not exist.
 *
 * `q`, `role` and `jobTitle` use `SearchTextSchema`, which rejects control characters (a NUL byte
 * would otherwise become a 500). `status` accepts only `active`: revealing `removed` requires an
 * administrative permission (SPEC §5, rule 9), and that value plus its guard arrive with the
 * removal task (#98/#105). Until then `?status=removed` is a 400, and the route always lists
 * active links.
 */
export const CollaboratorListQuerySchema = PaginationInputSchema.extend({
  q: SearchTextSchema.optional(),
  role: SearchTextSchema.max(128).optional(),
  jobTitle: SearchTextSchema.max(256).optional(),
  status: z.literal('active').optional()
}).strict();

export const CollaboratorListResponseSchema = createPaginatedResponseSchema(CollaboratorSchema);

/**
 * Response of `GET /agencies/:agencyId/collaborators/job-titles` (issue #218): the distinct job
 * titles that exist in one agency, for the job-title filter of the badge grid (#102). The listing
 * cannot serve this because it returns a single page, and the SPEC forbids changing its shape
 * (`specs/colaboradores.md` §6); the values are already trimmed, non-empty and unique.
 */
export const CollaboratorJobTitlesResponseSchema = z.object({
  data: z.array(z.string().trim().min(1).max(256))
}).strict();

export type CollaboratorRole = z.infer<typeof CollaboratorRoleSchema>;
export type Collaborator = z.infer<typeof CollaboratorSchema>;
export type CollaboratorListQuery = z.infer<typeof CollaboratorListQuerySchema>;
export type CollaboratorListResponse = z.infer<typeof CollaboratorListResponseSchema>;
export type CollaboratorJobTitlesResponse = z.infer<typeof CollaboratorJobTitlesResponseSchema>;
