import { raw, type DatabaseClient } from '@ageniza/database';

type EmailChangeTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** Codes `app_private.request_email_change` and `app_private.confirm_email_change` raise. */
export const EMAIL_CHANGE_ERRORS = {
  malformedAddress: 'A0041',
  invalidLink: 'A0042',
  sameAddress: 'A0043'
} as const;

export const databaseErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;

/**
 * Deadlock (40P01) and serialization failure (40001) are not bugs and not the caller's fault: the
 * statement lost a race with another transaction and can simply be repeated. They answer 409.
 */
export const isRetryableConflict = (error: unknown): boolean => {
  const code = databaseErrorCode(error);
  return code === '40P01' || code === '40001';
};

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

/** Records the request for the bound actor; the previous address comes from the database. */
export const requestEmailChange = async (
  transaction: EmailChangeTransaction,
  newEmail: string
): Promise<{ readonly requestId: string; readonly previousEmail: string }> => {
  const result = await raw<RawRows<{ request_id: string; previous_email: string }>>(transaction,
    'select * from app_private.request_email_change(?)', [newEmail]);
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
