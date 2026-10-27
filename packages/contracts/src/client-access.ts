import { z } from 'zod';

import { AuthEmailSchema } from './auth.js';
import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * Access to a client's portal, seen from the agency (specs/clientes.md sections 4 and 6). A person is an access given to an
 * e-mail address, with an account or without one (decision 2026-10-26, "acesso ao portal por e-mail"): the list names the
 * address exactly as it was recorded and never says whether that address has an account.
 */

export const ClientMemberStatusSchema = z.enum(['active', 'removed']);

/** `status` defaults to `active` in the route; `removed` lists the people who lost access. */
export const ClientMemberListQuerySchema = PaginationInputSchema.extend({
  status: ClientMemberStatusSchema.optional()
}).strict();

/** Body of "Adicionar pessoa": only the address. The access is given on the spot, with no invitation and no acceptance. */
export const ClientMemberAddRequestSchema = z.object({
  email: AuthEmailSchema
}).strict();

export const ClientMemberSchema = z.object({
  accessId: z.string().uuid(),
  /** The name of the account once the person has entered; `null` before, so the list is no oracle of which addresses have an account. */
  name: z.string().nullable(),
  /** The address as it was recorded. */
  email: z.string(),
  status: ClientMemberStatusSchema,
  /** `false` is "ainda não entrou": no account has linked the access yet. */
  entered: z.boolean(),
  /** When the access was created (`created_at`). */
  since: z.string()
}).strict();

export const ClientMemberListResponseSchema = createPaginatedResponseSchema(ClientMemberSchema);

/** Pending portal invitations take no filter: only the page controls. */
export const ClientInvitationListQuerySchema = PaginationInputSchema;

/** Never carries the token or its hash: the list tracks what is outstanding, it does not hand the link back. */
export const ClientPendingInvitationSchema = z.object({
  invitationId: z.string().uuid(),
  email: z.string(),
  expiresAt: z.string()
}).strict();

export const ClientInvitationListResponseSchema = createPaginatedResponseSchema(ClientPendingInvitationSchema);

export type ClientMemberStatus = z.infer<typeof ClientMemberStatusSchema>;
export type ClientMemberAddRequest = z.infer<typeof ClientMemberAddRequestSchema>;
export type ClientMemberListQuery= z.infer<typeof ClientMemberListQuerySchema>;
export type ClientMember = z.infer<typeof ClientMemberSchema>;
export type ClientMemberListResponse = z.infer<typeof ClientMemberListResponseSchema>;
export type ClientInvitationListQuery = z.infer<typeof ClientInvitationListQuerySchema>;
export type ClientPendingInvitation = z.infer<typeof ClientPendingInvitationSchema>;
export type ClientInvitationListResponse = z.infer<typeof ClientInvitationListResponseSchema>;
