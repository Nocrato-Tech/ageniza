import { z } from 'zod';

import { AgencyContextSchema } from './contexts.js';
import { createDisplayNameSchema } from './display-name.js';
import { hasInvisibleCharacters } from './invisible-characters.js';

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
 * applies; the owner receives the whole `permissions` catalog by ownership. `membershipId` is the person's OWN active link
 * with the agency (the id every other route of the agency names a collaborator by, never a user id), or `null` for an Owner by
 * ownership alone: the screen compares it with the `owner.membershipId` of a content to know whether the person is in charge.
 */
/**
 * The plan of the agency (issue #708). `readOnly` is decided by the database clock: the trial ended, so the database
 * refuses every write of the agency and of its portal except what reduces access. UX only, like the permissions.
 */
export const AgencyPlanSchema = z.object({
  kind: z.enum(['trial', 'ativo', 'isenta']),
  trialEndsAt: z.string().datetime().nullable(),
  readOnly: z.boolean(),
  /** The public contact of the operation (`SUPPORT_CONTACT_EMAIL`), or null when none is configured. */
  supportContactEmail: z.string().email().max(320).nullable().optional()
}).strict();

export const AgencyMeResponseSchema = z.object({
  agencyId: z.string().uuid(),
  agencyName: z.string().trim().min(1).max(256),
  isOwner: z.boolean(),
  membershipId: z.string().uuid().nullable(),
  role: AgencyMeRoleSchema,
  permissions: z.array(z.string().trim().min(1).max(128)),
  plan: AgencyPlanSchema
}).strict();

/** `POST /agencies` (issue #709): only the name; the actor becomes Owner of an agency in trial. */
export const CreateAgencyRequestSchema = z.object({
  name: createDisplayNameSchema(256)
    .refine((name) => new TextEncoder().encode(name).length <= 256, 'deve ter no máximo 256 bytes')
    .refine((name) => !hasInvisibleCharacters(name), 'não pode ter caracteres invisíveis')
}).strict();

/** The new agency context, so the screen enters it right away. */
export const CreateAgencyResponseSchema = z.object({
  context: AgencyContextSchema
}).strict();

export type AgencyMeRole = z.infer<typeof AgencyMeRoleSchema>;
export type AgencyPlan = z.infer<typeof AgencyPlanSchema>;
export type AgencyMeResponse = z.infer<typeof AgencyMeResponseSchema>;
export type CreateAgencyRequest = z.infer<typeof CreateAgencyRequestSchema>;
export type CreateAgencyResponse = z.infer<typeof CreateAgencyResponseSchema>;
