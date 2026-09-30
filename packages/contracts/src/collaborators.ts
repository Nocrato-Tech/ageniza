import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

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
 * `status` defaults to `active` in the route. Revealing `removed` requires an administrative
 * permission in the removal task (`#98`); this task only guarantees removed links stay out of the
 * default listing, never that it is gated here.
 */
export const CollaboratorListQuerySchema = PaginationInputSchema.extend({
  q: z.string().trim().min(1).max(320).optional(),
  role: z.string().trim().min(1).max(128).optional(),
  jobTitle: z.string().trim().min(1).max(256).optional(),
  status: z.enum(['active', 'removed']).optional()
}).strict();

export const CollaboratorListResponseSchema = createPaginatedResponseSchema(CollaboratorSchema);

export type CollaboratorRole = z.infer<typeof CollaboratorRoleSchema>;
export type Collaborator = z.infer<typeof CollaboratorSchema>;
export type CollaboratorListQuery = z.infer<typeof CollaboratorListQuerySchema>;
export type CollaboratorListResponse = z.infer<typeof CollaboratorListResponseSchema>;
