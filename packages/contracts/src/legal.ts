import { z } from 'zod';

/** The two documents an account accepts, each on its own version (specs/auth.md section 10). */
export const LEGAL_DOCUMENTS = ['terms', 'privacy'] as const;

export const LegalDocumentSchema = z.enum(LEGAL_DOCUMENTS);

/** `YYYY-MM-DD`, the format `AUTH_TERMS_VERSION` and `AUTH_PRIVACY_VERSION` enforce. */
const LegalVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * `POST /me/legal-acceptances` body. There is no `version` field on purpose: the server records the
 * version in force, so a client can neither accept a document that is not current nor claim a
 * future one. `.strict()` turns an attempt to send it into a 400 instead of a silently ignored key.
 */
export const AcceptLegalDocumentRequestSchema = z.object({
  document: LegalDocumentSchema
}).strict();

export const LegalDocumentStatusSchema = z.object({
  document: LegalDocumentSchema,
  /** The version in force on the server. */
  currentVersion: LegalVersionSchema,
  /** The newest version this account accepted, or null when it never accepted this document. */
  acceptedVersion: LegalVersionSchema.nullable(),
  /** True when the account has not accepted the version in force or a newer one. */
  pending: z.boolean()
}).strict();

/** Always one entry per document, `terms` first. Shared by the read and by the acceptance reply. */
export const LegalAcceptancesResponseSchema = z.object({
  documents: z.array(LegalDocumentStatusSchema).length(LEGAL_DOCUMENTS.length)
}).strict();

export type LegalDocumentKind = z.infer<typeof LegalDocumentSchema>;
export type AcceptLegalDocumentRequest = z.infer<typeof AcceptLegalDocumentRequestSchema>;
export type LegalDocumentStatus = z.infer<typeof LegalDocumentStatusSchema>;
export type LegalAcceptancesResponse = z.infer<typeof LegalAcceptancesResponseSchema>;
