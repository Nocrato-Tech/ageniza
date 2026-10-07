import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createLogger } from '@ageniza/core';
import { createEmailSender, emailChangeConfirmationEmail, type EmailSender } from '@ageniza/email';

import { EMAIL_CHANGE_LINK_TTL_HOURS, EMAIL_CHANGE_LINK_TTL_MINUTES } from '../modules/email-change/policy.js';
import { isRetryableConflict } from '../modules/email-change/service.js';
import {
  AgencyCliError,
  assertUuid,
  createAgencyCliDatabase,
  createInvitationToken,
  hashInvitationToken,
  loadAgencyCliEnvironment,
  type AgencyCliDatabase,
  type AgencyCliTransaction
} from './agency.js';

/**
 * The operation's side of the account e-mail change (issue #80): list the open requests, approve
 * one, or reject it. There is no administration screen, and the API has no route for this; the
 * command connects as the migration owner, exactly like `cli:agency`, and is run by whoever
 * operates the platform. docs/business/decisions.md, 2026-10-07.
 */

export class EmailChangeCliError extends AgencyCliError {}

export interface EmailChangeConfirmationEmail {
  readonly to: string;
  readonly actionUrl: string;
}

export interface EmailChangeMailer {
  sendConfirmationEmail(input: EmailChangeConfirmationEmail): Promise<void>;
  close(): Promise<void>;
}

interface RequestRow {
  readonly id: string;
  readonly user_id: string;
  readonly old_email: string;
  readonly new_email: string;
  readonly status: string;
}

export interface OpenEmailChangeRequest {
  readonly requestId: string;
  readonly status: 'pending' | 'approved';
  readonly requestedAt: string;
  readonly userId: string;
  readonly currentEmail: string;
  readonly newEmail: string;
  /** Another account already uses the new address: approving is refused until it is rejected. */
  readonly newEmailInUse: boolean;
  /** The account owns an agency: approving needs the ownership confirmed outside the product. */
  readonly isAgencyOwner: boolean;
  readonly linkExpiresAt: string | null;
}

export interface EmailChangeApprovalResult {
  readonly requestId: string;
  readonly linkExpiresAt: string;
}

export interface EmailChangeRejectionResult {
  readonly requestId: string;
  readonly status: 'rejected';
}

export interface EmailChangeCommandService {
  list(): Promise<readonly OpenEmailChangeRequest[]>;
  approve(input: { readonly requestId: string; readonly ownershipConfirmed: boolean }): Promise<EmailChangeApprovalResult>;
  reject(requestId: string): Promise<EmailChangeRejectionResult>;
}

export interface CreateEmailChangeCommandServiceOptions {
  readonly database: AgencyCliDatabase;
  readonly mailer: EmailChangeMailer;
  readonly appPublicUrl: string;
}

const confirmationUrl = (appPublicUrl: string, token: string): string =>
  `${appPublicUrl.replace(/\/+$/, '')}/email/confirmar?token=${encodeURIComponent(token)}`;

const asIso = (value: string | Date): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new EmailChangeCliError('The database returned an invalid timestamp.');
  return date.toISOString();
};

const recordAudit = async (transaction: AgencyCliTransaction, action: string, requestId: string): Promise<void> => {
  await transaction.query(
    `insert into audit.events (action, actor_user_id, agency_id, target_type, target_id, request_id)
     values (?, null, null, 'email_change_request', ?, ?)`,
    [action, requestId, `email-change-cli:${randomUUID()}`]
  );
};

/**
 * Locks the account and then its request, the order every path uses (see
 * `app_private.confirm_email_change`): the other order deadlocks (40P01) against a request or a
 * confirmation on the same account. The request is read once without a lock only to learn whose it
 * is; the locked read that follows is the one that counts.
 */
const lockAccountThenRequest = async (
  transaction: AgencyCliTransaction,
  requestId: string
): Promise<{ readonly request: RequestRow; readonly accountEmail: string | undefined }> => {
  const owner = await transaction.query<{ user_id: string }>('select user_id from public.email_change_requests where id = ?', [requestId]);
  const userId = owner.rows[0]?.user_id;
  if (userId === undefined) throw new EmailChangeCliError('Request not found.');
  const account = await transaction.query<{ email: string }>('select email from auth."user" where id = ? for update', [userId]);
  const locked = await transaction.query<RequestRow>(
    'select id, user_id, old_email, new_email, status from public.email_change_requests where id = ? for update',
    [requestId]
  );
  const request = locked.rows[0];
  if (request === undefined) throw new EmailChangeCliError('Request not found.');
  return { request, accountEmail: account.rows[0]?.email };
};

/** What an approval decided, computed inside the transaction and acted on after it commits. */
type ApprovalOutcome =
  | { readonly kind: 'approved'; readonly newEmail: string; readonly token: string; readonly expiresAt: string }
  | { readonly kind: 'stale' };

export const createEmailChangeCommandService = (options: CreateEmailChangeCommandServiceOptions): EmailChangeCommandService => {
  const list = (): Promise<readonly OpenEmailChangeRequest[]> => options.database.transaction(async (transaction) => {
    const result = await transaction.query<{
      id: string; status: 'pending' | 'approved'; requested_at: string | Date; user_id: string; old_email: string;
      new_email: string; in_use: boolean; is_owner: boolean; token_expires_at: string | Date | null;
    }>(`
      select request.id, request.status, request.requested_at, request.user_id, request.old_email, request.new_email,
        exists (select 1 from auth."user" other where other.email = request.new_email) as in_use,
        exists (select 1 from public.agencies agency where agency.owner_user_id = request.user_id) as is_owner,
        request.token_expires_at
      from public.email_change_requests request
      where request.status in ('pending', 'approved')
      order by request.requested_at, request.id
    `);
    return result.rows.map((row) => ({
      requestId: row.id,
      status: row.status,
      requestedAt: asIso(row.requested_at),
      userId: row.user_id,
      currentEmail: row.old_email,
      newEmail: row.new_email,
      newEmailInUse: row.in_use,
      isAgencyOwner: row.is_owner,
      linkExpiresAt: row.token_expires_at === null ? null : asIso(row.token_expires_at)
    }));
  });

  const approve = async (input: { readonly requestId: string; readonly ownershipConfirmed: boolean }): Promise<EmailChangeApprovalResult> => {
    const requestId = assertUuid(input.requestId, 'request-id');
    const outcome = await options.database.transaction(async (transaction): Promise<ApprovalOutcome> => {
      const { request, accountEmail } = await lockAccountThenRequest(transaction, requestId);
      // An approved request that was never spent can be approved again: it issues a fresh link,
      // which is how a lost or expired one is resent. Anything else is final.
      if (request.status !== 'pending' && request.status !== 'approved') {
        throw new EmailChangeCliError(`The request is ${request.status}; only a pending or approved request can be approved.`);
      }

      if (accountEmail !== request.old_email) {
        // The account changed address since the request, so it describes an account that no longer
        // exists as such. Closing it here must survive the refusal below.
        await transaction.query(
          `update public.email_change_requests
           set status = 'superseded', token_hash = null, token_expires_at = null, decided_at = now()
           where id = ?`, [request.id]
        );
        return { kind: 'stale' };
      }

      const inUse = await transaction.query<{ taken: boolean }>(
        'select exists (select 1 from auth."user" other where other.email = ?) as taken', [request.new_email]
      );
      if (inUse.rows[0]?.taken === true) {
        throw new EmailChangeCliError('The new address already belongs to another account; reject the request instead.');
      }

      const owner = await transaction.query<{ owns: boolean }>(
        'select exists (select 1 from public.agencies agency where agency.owner_user_id = ?) as owns', [request.user_id]
      );
      const isOwner = owner.rows[0]?.owns === true;
      if (isOwner && !input.ownershipConfirmed) {
        throw new EmailChangeCliError(
          'The account owns an agency, and its e-mail ties the subscription: confirm the holder outside the product, then run again with --ownership-confirmed.'
        );
      }

      const token = createInvitationToken();
      const updated = await transaction.query<{ token_expires_at: string | Date }>(
        `update public.email_change_requests
         set status = 'approved', token_hash = ?, token_expires_at = now() + make_interval(hours => ?),
             decided_at = now(), ownership_confirmed_at = case when ? then now() else null end
         where id = ?
         returning token_expires_at`,
        [hashInvitationToken(token), EMAIL_CHANGE_LINK_TTL_HOURS, isOwner, request.id]
      );
      const expires = updated.rows[0];
      if (expires === undefined) throw new EmailChangeCliError('The request could not be approved.');
      await recordAudit(transaction, 'email_change.approved', request.id);
      return { kind: 'approved', newEmail: request.new_email, token, expiresAt: asIso(expires.token_expires_at) };
    });

    if (outcome.kind === 'stale') {
      throw new EmailChangeCliError('The account changed its e-mail since the request, so the request was closed. Ask for a new one.');
    }
    // The transaction is committed before this await. A delivery failure leaves the request
    // approved, and approving it again issues a fresh link.
    await options.mailer.sendConfirmationEmail({
      to: outcome.newEmail,
      actionUrl: confirmationUrl(options.appPublicUrl, outcome.token)
    });
    return { requestId, linkExpiresAt: outcome.expiresAt };
  };

  const reject = (requestIdInput: string): Promise<EmailChangeRejectionResult> => {
    const requestId = assertUuid(requestIdInput, 'request-id');
    return options.database.transaction(async (transaction) => {
      const { request } = await lockAccountThenRequest(transaction, requestId);
      if (request.status !== 'pending' && request.status !== 'approved') {
        throw new EmailChangeCliError(`The request is ${request.status}; only a pending or approved request can be rejected.`);
      }
      await transaction.query(
        `update public.email_change_requests
         set status = 'rejected', token_hash = null, token_expires_at = null, decided_at = now()
         where id = ?`, [requestId]
      );
      await recordAudit(transaction, 'email_change.rejected', requestId);
      return { requestId, status: 'rejected' as const };
    });
  };

  return { list, approve, reject };
};

/** Uses the shared sender boundary; it never logs the action URL, token, or full recipient. */
export const createEmailChangeMailer = (input: { readonly smtpUrl: string; readonly emailFrom: string }): EmailChangeMailer => {
  const sender: EmailSender = createEmailSender({
    smtpUrl: input.smtpUrl,
    from: input.emailFrom,
    logger: createLogger({ enabled: false })
  });
  return {
    async sendConfirmationEmail(email): Promise<void> {
      const message = emailChangeConfirmationEmail({ actionUrl: email.actionUrl, expiresInMinutes: EMAIL_CHANGE_LINK_TTL_MINUTES });
      await sender.send({ ...message, to: email.to, template: 'email-change-confirmation' });
    },
    close: sender.close
  };
};

export type EmailChangeCliArguments =
  | { readonly command: 'list' }
  | { readonly command: 'approve'; readonly requestId: string; readonly ownershipConfirmed: boolean }
  | { readonly command: 'reject'; readonly requestId: string };

const usage = [
  'Usage:',
  '  node dist/cli/email-change.js list',
  '  node dist/cli/email-change.js approve --request-id <uuid> [--ownership-confirmed]',
  '  node dist/cli/email-change.js reject --request-id <uuid>'
].join('\n');

export const parseEmailChangeCliArguments = (argv: readonly string[]): EmailChangeCliArguments => {
  const command = argv[0];
  if (command !== 'list' && command !== 'approve' && command !== 'reject') throw new EmailChangeCliError(usage);
  if (command === 'list') {
    if (argv.length > 1) throw new EmailChangeCliError(`Unexpected argument.\n${usage}`);
    return { command };
  }
  let requestId: string | undefined;
  let ownershipConfirmed = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) break;
    if (argument === '--ownership-confirmed' && command === 'approve') {
      if (ownershipConfirmed) throw new EmailChangeCliError('Option --ownership-confirmed was supplied more than once.');
      ownershipConfirmed = true;
      continue;
    }
    const separator = argument.indexOf('=');
    const key = argument.startsWith('--') ? (separator === -1 ? argument.slice(2) : argument.slice(2, separator)) : undefined;
    if (key !== 'request-id') throw new EmailChangeCliError(`Unexpected argument.\n${usage}`);
    if (requestId !== undefined) throw new EmailChangeCliError('Option --request-id was supplied more than once.');
    const value = separator === -1 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new EmailChangeCliError('Option --request-id requires a value.');
    requestId = value;
  }
  if (requestId === undefined) throw new EmailChangeCliError('Option --request-id is required.');
  return command === 'approve' ? { command, requestId, ownershipConfirmed } : { command, requestId };
};

export interface EmailChangeCliIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface RunEmailChangeCliOptions {
  readonly argv?: readonly string[];
  readonly environment?: Record<string, string | undefined>;
  readonly io?: EmailChangeCliIo;
  readonly database?: AgencyCliDatabase;
  readonly mailer?: EmailChangeMailer;
}

export const runEmailChangeCli = async (options: RunEmailChangeCliOptions = {}): Promise<number> => {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  let database: AgencyCliDatabase | undefined = options.database;
  let mailer: EmailChangeMailer | undefined = options.mailer;
  try {
    const args = parseEmailChangeCliArguments(options.argv ?? process.argv.slice(2));
    const environment = loadAgencyCliEnvironment(options.environment ?? process.env);
    database ??= createAgencyCliDatabase(environment.migrationDatabaseUrl);
    mailer ??= createEmailChangeMailer({ smtpUrl: environment.smtpUrl, emailFrom: environment.emailFrom });
    const service = createEmailChangeCommandService({ database, mailer, appPublicUrl: environment.appPublicUrl });
    const result = args.command === 'list'
      ? await service.list()
      : args.command === 'approve'
        ? await service.approve({ requestId: args.requestId, ownershipConfirmed: args.ownershipConfirmed })
        : await service.reject(args.requestId);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof AgencyCliError
      ? error.message
      : isRetryableConflict(error)
        ? 'The account was being changed by another operation; nothing was done. Run the command again.'
        : 'E-mail change command failed.';
    io.stderr.write(`${message}\n`);
    return 1;
  } finally {
    await mailer?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
  }
};

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void runEmailChangeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
