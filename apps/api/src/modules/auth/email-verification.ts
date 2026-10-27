import { createHash, randomBytes } from 'node:crypto';

import { raw, type DatabaseClient } from '@ageniza/database';

/**
 * The confirmation link of an account lives in `public.email_confirmations`, reached only through the
 * `app_private` functions of migration 20261027010100. Better Auth's own e-mail verification is not
 * used: it is a stateless JWT carrying the address, replayable until it expires, that a resend does
 * not void and that confirms without the password. Here the token is random and carries nothing, only
 * its SHA-256 is stored, it works once, issuing another voids the previous ones, a password reset
 * voids them all, and consuming it needs the account's password.
 */
type DatabaseExecutor = Pick<DatabaseClient['knex'], 'raw'>;

export const hashEmailConfirmationToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Issues a new link for an unconfirmed account and voids every earlier one of it. Returns the token to
 * send, or undefined (issuing nothing) when the account does not exist or is already confirmed. The
 * caller sends it with `emailService.sendEmailVerification`; the invitation acceptance of #721 calls
 * this too.
 */
export const issueEmailConfirmation = async (executor: DatabaseExecutor, userId: string): Promise<string | undefined> => {
  const token = randomBytes(32).toString('base64url');
  const result = await raw<{ rows: Array<{ issued: boolean }> }>(
    executor,
    'select app_private.issue_email_confirmation(?::uuid, ?) as issued',
    [userId, hashEmailConfirmationToken(token)]
  );
  return result.rows[0]?.issued === true ? token : undefined;
};

export interface PendingVerification {
  readonly userId: string;
  readonly email: string;
}

/** Reads, without consuming, the unconfirmed account a live link belongs to. */
export const findPendingVerification = async (executor: DatabaseExecutor, token: string): Promise<PendingVerification | undefined> => {
  const result = await raw<{ rows: Array<{ user_id: string; email: string }> }>(
    executor,
    'select user_id, email from app_private.email_confirmation_by_token_hash(?)',
    [hashEmailConfirmationToken(token)]
  );
  const row = result.rows[0];
  return row === undefined ? undefined : { userId: row.user_id, email: row.email };
};

/**
 * Consumes the link and confirms the e-mail, only while the account still has the credential the
 * caller verified the password against: a reset in between makes it fail. Returns whether the account
 * was confirmed.
 */
export const consumeEmailVerification = async (
  executor: DatabaseExecutor,
  token: string,
  verifiedPasswordHash: string
): Promise<boolean> => {
  const result = await raw<{ rows: Array<{ user_id: string | null }> }>(
    executor,
    'select app_private.consume_email_confirmation(?, ?) as user_id',
    [hashEmailConfirmationToken(token), verifiedPasswordHash]
  );
  return typeof result.rows[0]?.user_id === 'string';
};
