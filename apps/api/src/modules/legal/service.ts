import { LEGAL_DOCUMENTS, type LegalAcceptancesResponse, type LegalDocumentKind } from '@ageniza/contracts';
import { raw, type DatabaseClient } from '@ageniza/database';

type LegalTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** The version in force for each document, which only the server configuration decides. */
export type CurrentLegalVersions = Readonly<Record<LegalDocumentKind, string>>;

/**
 * What the account accepted against what is in force. The newest accepted version wins, so an
 * account that accepted a version newer than the configured one (a rolled-back deploy) is not
 * pending and is never moved backwards. `YYYY-MM-DD` compares correctly as plain strings.
 */
export const loadLegalStatus = async (
  transaction: LegalTransaction,
  userId: string,
  current: CurrentLegalVersions
): Promise<LegalAcceptancesResponse> => {
  const result = await raw<RawRows<{ document: LegalDocumentKind; version: string }>>(transaction, `
    select document, max(version collate "C") as version
    from public.legal_acceptances
    where user_id = ?::uuid
    group by document
  `, [userId]);
  const accepted = new Map(result.rows.map((row) => [row.document, row.version]));

  return {
    documents: LEGAL_DOCUMENTS.map((document) => {
      const acceptedVersion = accepted.get(document) ?? null;
      return {
        document,
        currentVersion: current[document],
        acceptedVersion,
        pending: acceptedVersion === null || acceptedVersion < current[document]
      };
    })
  };
};

/**
 * Records the acceptance of one document at the version in force. Everything the database needs to
 * know about who is accepting comes from the actor bound to the transaction, and the function is a
 * no-op when the account already accepted that version or a newer one.
 */
export const acceptLegalDocument = async (
  transaction: LegalTransaction,
  document: LegalDocumentKind,
  current: CurrentLegalVersions
): Promise<void> => {
  await raw(transaction, 'select app_private.accept_legal_document(?, ?)', [document, current[document]]);
};
