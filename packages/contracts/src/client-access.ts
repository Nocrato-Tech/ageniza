import { z } from 'zod';

import { createPaginatedResponseSchema, PaginationInputSchema } from './pagination.js';

/**
 * Access to a client's portal, seen from the agency (specs/clientes.md sections 4 and 6). A person
 * is named through their link to the client, never through `auth."user"` on its own.
 */

export const ClientMemberStatusSchema = z.enum(['active', 'removed']);

/** `status` defaults to `active` in the route; `removed` lists the people who lost access. */
export const ClientMemberListQuerySchema = PaginationInputSchema.extend({
  status: ClientMemberStatusSchema.optional()
}).strict();

export const ClientMemberSchema = z.object({
  membershipId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  status: ClientMemberStatusSchema,
  /** When the link was created (`created_at`). */
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
export type ClientMemberListQuery = z.infer<typeof ClientMemberListQuerySchema>;
export type ClientMember = z.infer<typeof ClientMemberSchema>;
export type ClientMemberListResponse = z.infer<typeof ClientMemberListResponseSchema>;
export type ClientInvitationListQuery = z.infer<typeof ClientInvitationListQuerySchema>;
export type ClientPendingInvitation = z.infer<typeof ClientPendingInvitationSchema>;
export type ClientInvitationListResponse = z.infer<typeof ClientInvitationListResponseSchema>;
