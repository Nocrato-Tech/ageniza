import { z } from 'zod';

/**
 * `GET /agencies/:agencyId/me` role label. Owner is not a role (it is `agencies.owner_user_id`),
 * so an owner without an active membership falls back to the `admin` preset label, exactly as
 * `GET /me/contexts` already reports it.
 */
export const AgencyMeRoleSchema = z.object({
  key: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256)
}).strict();

/**
 * Effective permissions of the active agency context. This response is a UX input only: the menu
 * may hide what it does not list, but the backend validates every operation against the same
 * database source, so discovering or forging this list grants nothing. The list for a member is
 * derived from `agency_memberships` -> `roles` -> `role_permissions` with the same role scope
 * (`role.agency_id is null or role.agency_id = agencyId`) `app_private.has_agency_permission`
 * applies; the owner receives the whole `permissions` catalog by ownership.
 */
export const AgencyMeResponseSchema = z.object({
  agencyId: z.string().uuid(),
  agencyName: z.string().trim().min(1).max(256),
  isOwner: z.boolean(),
  role: AgencyMeRoleSchema,
  permissions: z.array(z.string().trim().min(1).max(128))
}).strict();

export type AgencyMeRole = z.infer<typeof AgencyMeRoleSchema>;
export type AgencyMeResponse = z.infer<typeof AgencyMeResponseSchema>;
