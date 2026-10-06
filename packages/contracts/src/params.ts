import { z } from 'zod';

import { WritableBrandSectionKeySchema } from './clients.js';

/**
 * Path parameter schemas shared by routes and the generated OpenAPI document. They live in
 * `@ageniza/contracts` so the route that validates and the documentation that describes it can
 * never drift into two different definitions (issue #182).
 */

export const AgencyPathParamsSchema = z.object({ agencyId: z.string().uuid() }).strict();

export const ClientPathParamsSchema = z.object({ clientId: z.string().uuid() }).strict();

export const AgencyInvitationPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  invitationId: z.string().uuid()
}).strict();

export const AgencyClientPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid()
}).strict();

export const AgencyCollaboratorPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  // A plain string, not `.uuid()`: a malformed membership id must answer the same 404 as a
  // nonexistent or other-agency one, never a 400 that would distinguish it. The route checks the
  // UUID itself and turns a bad value into the same 404 (issue #96). 100 is Fastify's own
  // `maxParamLength`, so every segment that reaches the handler passes this and is judged there.
  membershipId: z.string().min(1).max(100)
}).strict();

export const AgencyMediaAssetPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  assetId: z.string().uuid()
}).strict();

// The writable keys are the enum so the generated OpenAPI lists the six values; `personas` is a
// fixed section but not writable, and the route still answers its own 400 for it.
export const AgencyClientSectionPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  sectionKey: WritableBrandSectionKeySchema
}).strict();

export const AgencyClientPersonaPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  personaId: z.string().uuid()
}).strict();

export const PublicInvitationTokenPathParamsSchema = z.object({
  token: z.string().min(1).max(2_048)
}).strict();

export type AgencyPathParams = z.infer<typeof AgencyPathParamsSchema>;
export type ClientPathParams = z.infer<typeof ClientPathParamsSchema>;
export type AgencyInvitationPathParams = z.infer<typeof AgencyInvitationPathParamsSchema>;
export type AgencyClientPathParams = z.infer<typeof AgencyClientPathParamsSchema>;
export type AgencyCollaboratorPathParams = z.infer<typeof AgencyCollaboratorPathParamsSchema>;
export type AgencyMediaAssetPathParams = z.infer<typeof AgencyMediaAssetPathParamsSchema>;
export type AgencyClientSectionPathParams = z.infer<typeof AgencyClientSectionPathParamsSchema>;
export type AgencyClientPersonaPathParams = z.infer<typeof AgencyClientPersonaPathParamsSchema>;
export type PublicInvitationTokenPathParams = z.infer<typeof PublicInvitationTokenPathParamsSchema>;
