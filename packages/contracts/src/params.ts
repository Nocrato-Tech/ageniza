import { z } from 'zod';

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

export const AgencyMediaAssetPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  assetId: z.string().uuid()
}).strict();

export const AgencyClientSectionPathParamsSchema = z.object({
  agencyId: z.string().uuid(),
  clientId: z.string().uuid(),
  sectionKey: z.string().min(1).max(64)
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
export type AgencyMediaAssetPathParams = z.infer<typeof AgencyMediaAssetPathParamsSchema>;
export type AgencyClientSectionPathParams = z.infer<typeof AgencyClientSectionPathParamsSchema>;
export type AgencyClientPersonaPathParams = z.infer<typeof AgencyClientPersonaPathParamsSchema>;
export type PublicInvitationTokenPathParams = z.infer<typeof PublicInvitationTokenPathParamsSchema>;
