import { z } from 'zod';

import {
  PortalApproveContentRequestSchema,
  PortalContentInProductionSchema,
  PortalContentMediaPathParamsSchema,
  PortalContentMediaUrlQuerySchema,
  PortalContentMediaUrlResponseSchema,
  PortalContentOpenDetailSchema,
  PortalRequestContentChangesRequestSchema
} from './portal-contents.js';

/**
 * The approval link of the e-mail "conteúdos para aprovar" (issue #712, decision 2026-10-26): the page of the link opens the contents
 * of one batch, with the phone preview, Aprovar and Pedir ajuste, and nothing else of the portal. The token is in the fragment of the
 * URL (`#`), which the browser never sends; the page reads it, erases it from the address bar and exchanges it, by POST, for a session
 * cookie that reaches only these routes. Opening the link decides nothing: the two decisions are POSTs.
 */

/** The page of the link in the web app. The token comes after `#` (`${origin}${PORTAL_APPROVAL_PAGE_PATH}#${token}`) and never in a query. */
export const PORTAL_APPROVAL_PAGE_PATH = '/aprovar';

/** 32 random bytes in base64url, as the worker generates it. A malformed token is a 400 before it reaches the database. */
export const PORTAL_APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Body of `POST /portal-approval/session`. The token travels in the body and never in the URL: a URL reaches logs and `Referer`. */
export const PortalApprovalExchangeRequestSchema = z.object({
  token: z.string().regex(PORTAL_APPROVAL_TOKEN_PATTERN, 'The token of the link is malformed.')
}).strict();

/** The cookie itself is `Set-Cookie`; the body only says until when the session and the link last. */
export const PortalApprovalExchangeResponseSchema = z.object({
  sessionExpiresAt: z.string().datetime(),
  linkExpiresAt: z.string().datetime()
}).strict();

/**
 * A content of the batch in its current state. `canDecide` is the only thing that tells the page whether to draw the two buttons:
 * it is true exactly when the content is awaiting approval. A content in production is its title, day and format and never has buttons.
 */
export const PortalApprovalContentSchema = z.union([
  PortalContentInProductionSchema.extend({ canDecide: z.literal(false) }).strict(),
  PortalContentOpenDetailSchema.extend({ canDecide: z.boolean() }).strict()
]);

/** The batch: who sends, who it is for and the contents. Nothing of the brand, the general conversation or other contents. */
export const PortalApprovalBatchSchema = z.object({
  clientName: z.string(),
  agencyName: z.string(),
  /**
   * The address the access was given to. The page uses it to offer "Criar conta para ver o portal" (`/criar-conta` with this address
   * filled in), and says nothing about whether the address already has an account.
   */
  personEmail: z.string(),
  sessionExpiresAt: z.string().datetime(),
  linkExpiresAt: z.string().datetime(),
  contents: z.array(PortalApprovalContentSchema)
}).strict();

/** No route of the link takes a query: a token (or anything else) in the URL is a 400, so it never sits in a log by mistake. */
export const PortalApprovalNoQuerySchema = z.object({}).strict();

export const PortalApprovalContentPathParamsSchema = z.object({
  contentId: z.string().uuid()
}).strict();

export const PortalApprovalMediaPathParamsSchema = PortalContentMediaPathParamsSchema.omit({ clientId: true });

export const PortalApprovalMediaUrlQuerySchema = PortalContentMediaUrlQuerySchema;
export const PortalApprovalMediaUrlResponseSchema = PortalContentMediaUrlResponseSchema;

export const PortalApprovalApproveRequestSchema = PortalApproveContentRequestSchema;
export const PortalApprovalRequestChangesRequestSchema = PortalRequestContentChangesRequestSchema;

export type PortalApprovalExchangeRequest = z.infer<typeof PortalApprovalExchangeRequestSchema>;
export type PortalApprovalExchangeResponse = z.infer<typeof PortalApprovalExchangeResponseSchema>;
export type PortalApprovalContent = z.infer<typeof PortalApprovalContentSchema>;
export type PortalApprovalBatch = z.infer<typeof PortalApprovalBatchSchema>;
export type PortalApprovalApproveRequest = z.infer<typeof PortalApprovalApproveRequestSchema>;
export type PortalApprovalRequestChangesRequest = z.infer<typeof PortalApprovalRequestChangesRequestSchema>;
