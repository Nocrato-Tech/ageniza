import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';
import { NO_CONTROL_CHARACTERS, SearchTextSchema } from './search.js';

/** Longest job title, counted in UTF-16 units like every `max` of this contract. */
export const COLLABORATOR_JOB_TITLE_MAX_LENGTH = 256;

/**
 * A job title a request may write: trimmed, 1 to 256 characters, and free of control characters.
 * The control rule is the one `jobTitle` of the listing filter applies (`SearchTextSchema`), so a
 * title this schema accepts is always one the filter can select -- a title the database stores but
 * the filter refuses (400) could never be filtered by.
 *
 * The length is checked here, before the statement reaches the database: the database measures it
 * with a per-character function that is quadratic in the input.
 */
export const CollaboratorJobTitleSchema = z.string()
  .trim()
  .min(1)
  .max(COLLABORATOR_JOB_TITLE_MAX_LENGTH)
  .regex(NO_CONTROL_CHARACTERS, 'Job title cannot contain control characters');

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
 * would otherwise become a 500). `status` is `active` by default; `removed` is a valid value, but
 * the schema cannot grant it: revealing removed links requires an administrative permission (SPEC
 * §5, rule 9), which the route checks against the caller (issue #98, decisions.md 2026-10-07).
 */
export const CollaboratorListQuerySchema = PaginationInputSchema.extend({
  q: SearchTextSchema.optional(),
  role: SearchTextSchema.max(128).optional(),
  jobTitle: SearchTextSchema.max(COLLABORATOR_JOB_TITLE_MAX_LENGTH).optional(),
  status: z.enum(['active', 'removed']).optional()
}).strict();

export const CollaboratorListResponseSchema = createPaginatedResponseSchema(CollaboratorSchema);

/**
 * Body of `PATCH /agencies/:agencyId/collaborators/:membershipId` (issue #97). Either field, or
 * both; the permission each one needs is decided from the fields that are present, not from the
 * route. `jobTitle: null` clears the title. An empty body is a validation error, never a 200 that
 * changed nothing.
 */
export const UpdateCollaboratorRequestSchema = z.object({
  jobTitle: CollaboratorJobTitleSchema.nullable().optional(),
  roleId: z.string().uuid().optional()
}).strict().refine(
  (body) => body.jobTitle !== undefined || body.roleId !== undefined,
  { message: 'Send at least one of jobTitle or roleId.' }
);

/**
 * Body of `POST /agencies/:agencyId/collaborators/:membershipId/reactivate` (issue #98). The role is
 * required and never defaults to the previous one: whoever comes back may come back in another
 * function, and inheriting the old authorization silently is what the rule exists to prevent
 * (`specs/autorizacao.md`, `specs/colaboradores.md` §4 and §5 rule 7).
 */
export const ReactivateCollaboratorRequestSchema = z.object({
  roleId: z.string().uuid()
}).strict();

/**
 * Query of `GET /agencies/:agencyId/collaborators/:membershipId` (issue #226). The detail declares
 * no query parameter, and an empty `.strict()` object is what makes an undeclared one (`?x=1`) a
 * 400, exactly like the listing: a parameter the SPEC does not declare does not exist.
 */
export const CollaboratorDetailQuerySchema = z.object({}).strict();

/**
 * Query of `GET /agencies/:agencyId/collaborators/job-titles` (issue #226, route of #218). The
 * route declares no query parameter either, and the same empty `.strict()` object makes an
 * undeclared one a 400.
 */
export const CollaboratorJobTitlesQuerySchema = z.object({}).strict();

/**
 * Response of `GET /agencies/:agencyId/collaborators/job-titles` (issue #218): the distinct job
 * titles that exist in one agency, for the job-title filter of the badge grid (#102). The listing
 * cannot serve this because it returns a single page, and the SPEC forbids changing its shape
 * (`specs/colaboradores.md` §6); the values are already trimmed, non-empty and unique.
 */
export const CollaboratorJobTitlesResponseSchema = z.object({
  data: z.array(z.string().trim().min(1).max(256))
}).strict();

/**
 * One role of `GET /agencies/:agencyId/roles` (issue #287): a system preset or one of the agency's
 * own custom roles, with the `id` the invitation (#107), the role PATCH (#97) and the reactivation
 * (#98) routes require. The screens order and filter the list themselves; the API only hides
 * `admin` from callers who are not the Owner, because only ownership grants it.
 */
export const AgencyRoleSchema = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256)
}).strict();

/**
 * Query of `GET /agencies/:agencyId/roles`. Like the detail and the job titles, the route declares
 * no query parameter, and the empty `.strict()` object makes an undeclared one (`?x=1`) a 400.
 */
export const AgencyRolesQuerySchema = z.object({}).strict();

/** Response of `GET /agencies/:agencyId/roles`: the plain list, never paginated. */
export const AgencyRolesResponseSchema = z.object({
  data: z.array(AgencyRoleSchema)
}).strict();

export type CollaboratorRole = z.infer<typeof CollaboratorRoleSchema>;
export type Collaborator = z.infer<typeof CollaboratorSchema>;
export type UpdateCollaboratorRequest = z.infer<typeof UpdateCollaboratorRequestSchema>;
export type ReactivateCollaboratorRequest = z.infer<typeof ReactivateCollaboratorRequestSchema>;
export type CollaboratorListQuery = z.infer<typeof CollaboratorListQuerySchema>;
export type CollaboratorListResponse = z.infer<typeof CollaboratorListResponseSchema>;
export type CollaboratorDetailQuery = z.infer<typeof CollaboratorDetailQuerySchema>;
export type CollaboratorJobTitlesQuery = z.infer<typeof CollaboratorJobTitlesQuerySchema>;
export type CollaboratorJobTitlesResponse = z.infer<typeof CollaboratorJobTitlesResponseSchema>;
export type AgencyRole = z.infer<typeof AgencyRoleSchema>;
export type AgencyRolesQuery = z.infer<typeof AgencyRolesQuerySchema>;
export type AgencyRolesResponse = z.infer<typeof AgencyRolesResponseSchema>;
