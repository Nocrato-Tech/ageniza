import { z } from 'zod';

import { AuthEmailSchema, AuthNoBodySchema, AuthPasswordSchema } from './auth.js';

/** Invitation purpose values exposed by the public invitation endpoints. */
export const InvitationPurposeSchema = z.enum([
  'agency_activation',
  'collaborator_invite',
  'client_invite'
]);

export const InvitationAgencySchema = z.object({
  name: z.string().trim().min(1).max(256)
}).strict();

export const InvitationClientSchema = z.object({
  name: z.string().trim().min(1).max(256)
}).strict();

/** Public invitation preview returned only while the token is valid. */
export const InvitationPreviewResponseSchema = z.object({
  purpose: InvitationPurposeSchema,
  email: AuthEmailSchema,
  agency: InvitationAgencySchema,
  client: InvitationClientSchema.nullable(),
  accountExists: z.boolean()
}).strict();

/** Context created by accepting an invitation; clientId is null for agency activation. */
export const InvitationContextSchema = z.object({
  agencyId: z.string().trim().min(1).max(128),
  clientId: z.string().trim().min(1).max(128).nullable()
}).strict();

export const InvitationAcceptNewAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  password: AuthPasswordSchema,
  acceptTerms: z.literal(true)
}).strict();

export const InvitationAcceptNewAccountResponseSchema = z.object({
  status: z.literal('accepted'),
  context: InvitationContextSchema
}).strict();

export const InvitationAcceptRequestSchema = AuthNoBodySchema;

export const InvitationAcceptResponseSchema = z.object({
  status: z.enum(['accepted', 'already_member']),
  context: InvitationContextSchema
}).strict();

// Endpoint-local aliases keep route code concise while the descriptive names remain available to
// clients importing the package root.
export const InvitationDetailsResponseSchema = InvitationPreviewResponseSchema;
export const AcceptInvitationNewAccountRequestSchema = InvitationAcceptNewAccountRequestSchema;
export const AcceptInvitationNewAccountResponseSchema = InvitationAcceptNewAccountResponseSchema;
export const AcceptInvitationRequestSchema = InvitationAcceptRequestSchema;
export const AcceptInvitationResponseSchema = InvitationAcceptResponseSchema;

export type InvitationPurpose = z.infer<typeof InvitationPurposeSchema>;
export type InvitationAgency = z.infer<typeof InvitationAgencySchema>;
export type InvitationClient = z.infer<typeof InvitationClientSchema>;
export type InvitationPreviewResponse = z.infer<typeof InvitationPreviewResponseSchema>;
export type InvitationContext = z.infer<typeof InvitationContextSchema>;
export type InvitationAcceptNewAccountRequest = z.infer<typeof InvitationAcceptNewAccountRequestSchema>;
export type InvitationAcceptNewAccountResponse = z.infer<typeof InvitationAcceptNewAccountResponseSchema>;
export type InvitationAcceptRequest = z.infer<typeof InvitationAcceptRequestSchema>;
export type InvitationAcceptResponse = z.infer<typeof InvitationAcceptResponseSchema>;
