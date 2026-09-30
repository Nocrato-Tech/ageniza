import { z } from 'zod';

import { AuthNoContentResponseSchema } from './auth.js';

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

/** `preferred=agency:<uuid>` or `preferred=client:<uuid>`, parsed from the raw query string.
 * Syntax and access are deliberately handled by the resolver. Any malformed shape, including a
 * repeated query parameter (array) or an oversized string, becomes absent instead of a 400.
 * `preprocess` instead of `transform` keeps the exact same behavior while letting the generated
 * OpenAPI document describe the parameter as a string (issue #182). */
export const ContextResolvePreferredSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized.length <= 256 ? normalized : undefined;
  },
  z.string().optional()
);

export const ContextResolveQuerySchema = z.object({
  preferred: ContextResolvePreferredSchema
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

/** `PUT /me/last-context` answers 204 with no body, like the other no-content routes. */
export const PutLastContextResponseSchema = AuthNoContentResponseSchema;

export type AgencyContext = z.infer<typeof AgencyContextSchema>;
export type ClientContext = z.infer<typeof ClientContextSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type MeContextsResponse = z.infer<typeof MeContextsResponseSchema>;
export type ContextResolveQuery = z.infer<typeof ContextResolveQuerySchema>;
export type ContextResolveResponse = z.infer<typeof ContextResolveResponseSchema>;
export type PutLastContextRequest = z.infer<typeof PutLastContextRequestSchema>;
