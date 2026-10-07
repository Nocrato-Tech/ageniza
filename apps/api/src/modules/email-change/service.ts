import { raw, type DatabaseClient } from '@ageniza/database';

type EmailChangeTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/**
 * Codes `app_private.request_email_change` and `app_private.confirm_email_change` raise. `invalidLink`
 * is also what the request raises when the credential the password was verified against is no longer
 * the account's.
 */
export const EMAIL_CHANGE_ERRORS = {
  malformedAddress: 'A0041',
  invalidLink: 'A0042',
  sameAddress: 'A0043'
} as const;

/** Re-exported for this module's callers; the implementation lives in the database package. */
export { databaseErrorCode, isRetryableConflict } from '@ageniza/database';

/**
 * The hash of the account's credential. `auth.account` has no RLS, so the user id is always the
 * verified session user, never a value from the request.
 */
export const loadCredentialHash = async (transaction: EmailChangeTransaction, userId: string): Promise<string | undefined> => {
  const result = await raw<RawRows<{ password: string | null }>>(transaction, `
    select password
    from auth.account
    where "userId" = ?::uuid and "providerId" = 'credential'
    limit 1
  `, [userId]);
  return result.rows[0]?.password ?? undefined;
};

/**
 * Records the request for the bound actor; the previous address comes from the database. The hash is
 * the one the password was just verified against: the request is recorded under that credential, and
 * refused if the account's has moved since.
 */
export const requestEmailChange = async (
  transaction: EmailChangeTransaction,
  newEmail: string,
  verifiedHash: string
): Promise<{ readonly requestId: string; readonly previousEmail: string }> => {
  const result = await raw<RawRows<{ request_id: string; previous_email: string }>>(transaction,
    'select * from app_private.request_email_change(?, ?)', [newEmail, verifiedHash]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The e-mail change request was not recorded.');
  return { requestId: row.request_id, previousEmail: row.previous_email };
};

/** Spends the link in the new mailbox and swaps the address; nothing else decides the swap. */
export const confirmEmailChange = async (
  transaction: EmailChangeTransaction,
  tokenHash: string
): Promise<{ readonly accountId: string; readonly previousEmail: string }> => {
  const result = await raw<RawRows<{ account_id: string; previous_email: string }>>(transaction,
    'select * from app_private.confirm_email_change(?)', [tokenHash]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The e-mail change was not confirmed.');
  return { accountId: row.account_id, previousEmail: row.previous_email };
};
