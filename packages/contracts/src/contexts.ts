import { z } from 'zod';

/** An agency context the current user may enter (owner or an active membership). */
export const AgencyContextSchema = z.object({
  type: z.literal('agency'),
  agencyId: z.string().uuid(),
  agencyName: z.string().trim().min(1).max(256),
  roleKey: z.string().trim().min(1).max(128),
  roleName: z.string().trim().min(1).max(256),
  isOwner: z.boolean()
}).strict();

/** A client portal context the current user may enter, via an active client membership. */
export const ClientContextSchema = z.object({
  type: z.literal('client'),
  clientId: z.string().uuid(),
  clientName: z.string().trim().min(1).max(256),
  agencyId: z.string().uuid(),
  agencyName: z.string().trim().min(1).max(256),
  onboardingPending: z.boolean()
}).strict();

export const ContextSchema = z.discriminatedUnion('type', [AgencyContextSchema, ClientContextSchema]);

/** `GET /me/contexts` response: every valid context for the current user, already ordered. */
export const MeContextsResponseSchema = z.object({
  contexts: z.array(ContextSchema)
}).strict();

/** `preferred=agency:<uuid>` or `preferred=client:<uuid>`, parsed from the raw query string. */
export const ContextResolvePreferredSchema = z.string().trim().min(1).max(256).regex(
  /^(agency|client):[0-9a-fA-F-]{36}$/,
  'must be "agency:<uuid>" or "client:<uuid>"'
);

export const ContextResolveQuerySchema = z.object({
  preferred: ContextResolvePreferredSchema.optional()
}).strict();

export const ContextResolveNoneSchema = z.object({
  decision: z.literal('none')
}).strict();

export const ContextResolveEnterSchema = z.object({
  decision: z.literal('enter'),
  context: ContextSchema
}).strict();

export const ContextResolveSelectSchema = z.object({
  decision: z.literal('select'),
  contexts: z.array(ContextSchema),
  highlighted: ContextSchema.nullable()
}).strict();

/** `GET /me/contexts/resolve` response: exactly one of `none`, `enter`, or `select`. */
export const ContextResolveResponseSchema = z.discriminatedUnion('decision', [
  ContextResolveNoneSchema,
  ContextResolveEnterSchema,
  ContextResolveSelectSchema
]);

/** `PUT /me/last-context` request body. */
export const PutLastContextRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agency'), agencyId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('client'), clientId: z.string().uuid() }).strict()
]);

export type AgencyContext = z.infer<typeof AgencyContextSchema>;
export type ClientContext = z.infer<typeof ClientContextSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type MeContextsResponse = z.infer<typeof MeContextsResponseSchema>;
export type ContextResolveQuery = z.infer<typeof ContextResolveQuerySchema>;
export type ContextResolveResponse = z.infer<typeof ContextResolveResponseSchema>;
export type PutLastContextRequest = z.infer<typeof PutLastContextRequestSchema>;
