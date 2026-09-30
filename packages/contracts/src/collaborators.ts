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
 * would otherwise become a 500). `status` accepts `active` and `removed`; the route refuses
 * `removed` to a caller without the administrative permission the SPEC requires (rule 9).
 */
export const CollaboratorListQuerySchema = PaginationInputSchema.extend({
  q: SearchTextSchema.optional(),
  role: SearchTextSchema.max(128).optional(),
  jobTitle: SearchTextSchema.max(256).optional(),
  status: z.enum(['active', 'removed']).optional()
}).strict();

/**
 * Body of `POST /agencies/:agencyId/collaborators/:membershipId/reactivate`. The new role is
 * mandatory: a removed link keeps its previous `role_id` in the database, and reusing it silently
 * is exactly what `specs/autorizacao.md` rule 8 forbids.
 */
export const ReactivateCollaboratorRequestSchema = z.object({
  roleId: z.string().uuid()
}).strict();

export const CollaboratorListResponseSchema = createPaginatedResponseSchema(CollaboratorSchema);

export type CollaboratorRole = z.infer<typeof CollaboratorRoleSchema>;
export type Collaborator = z.infer<typeof CollaboratorSchema>;
export type CollaboratorListQuery = z.infer<typeof CollaboratorListQuerySchema>;
export type CollaboratorListResponse = z.infer<typeof CollaboratorListResponseSchema>;
export type ReactivateCollaboratorRequest = z.infer<typeof ReactivateCollaboratorRequestSchema>;
