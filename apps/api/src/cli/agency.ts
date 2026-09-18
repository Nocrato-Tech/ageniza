import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { z } from 'zod';

import { createLogger } from '@ageniza/core';
import { createDatabaseClient, raw, type SqlBinding } from '@ageniza/database';
import { agencyActivationEmail, assertEmailAddress, createEmailSender, type EmailSender } from '@ageniza/email';

const INVITATION_EXPIRY_MINUTES = 7 * 24 * 60;
type KnexRawExecutor = Parameters<typeof raw>[0];

/** The CLI's database seam deliberately exposes only parameterized SQL in a transaction. */
export interface AgencyCliTransaction {
  query<TRow extends object>(statement: string, bindings?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

export interface AgencyCliDatabase {
  transaction<TResult>(work: (transaction: AgencyCliTransaction) => Promise<TResult>): Promise<TResult>;
  close(): Promise<void>;
}

export interface AgencyActivationEmail {
  readonly to: string;
  readonly agencyName: string;
  readonly actionUrl: string;
  readonly expiresAt: string;
}

export interface AgencyActivationMailer {
  sendActivationEmail(input: AgencyActivationEmail): Promise<void>;
  close(): Promise<void>;
}

export class AgencyCliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgencyCliError';
  }
}

const queryWithKnex = async <TRow extends object>(
  transaction: KnexRawExecutor,
  statement: string,
  bindings: readonly unknown[] = []
): Promise<{ rows: TRow[] }> => {
  const result = await raw(transaction, statement, bindings as SqlBinding[]);
  return result as unknown as { rows: TRow[] };
};

/** Adapts the shared Knex client without allowing a non-transactional CLI query. */
export const createAgencyCliDatabase = (connectionString: string): AgencyCliDatabase => {
  const database = createDatabaseClient({ connectionString });
  return {
    transaction: (work) => database.transaction((transaction) => work({
      query: <TRow extends object>(statement: string, bindings: readonly unknown[] = []) =>
        queryWithKnex<TRow>(transaction, statement, bindings)
    })),
    close: database.close
  };
};

const normalizedEmailSchema = z.string().trim().email().max(320);

export const normalizeEmail = (value: string): string => {
  const email = value.trim().toLowerCase();
  if (!normalizedEmailSchema.safeParse(email).success) {
    throw new AgencyCliError('owner-email must be a valid email address.');
  }
  return email;
};

export const normalizeAgencyName = (value: string): string => {
  const name = value.trim();
  if (name.length === 0) throw new AgencyCliError('name must not be blank.');
  return name;
};

export const assertUuid = (value: string, optionName = 'agency-id'): string => {
  if (!z.string().uuid().safeParse(value).success) {
    throw new AgencyCliError(`${optionName} must be a valid UUID.`);
  }
  return value;
};

export const createInvitationToken = (): string => randomBytes(32).toString('base64url');

export const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const appUrlFor = (appPublicUrl: string, token: string): string =>
  `${appPublicUrl.replace(/\/+$/, '')}/invite/${encodeURIComponent(token)}`;

const asIsoDate = (value: string | Date): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AgencyCliError('The database returned an invalid invitation expiration.');
  return date.toISOString();
};

const oneRow = <TRow extends object>(rows: TRow[], message: string): TRow => {
  const row = rows[0];
  if (row === undefined) throw new AgencyCliError(message);
  return row;
};

interface AgencyRow {
  readonly id: string;
  readonly name?: string;
  readonly status?: 'active' | 'suspended';
  readonly owner_user_id?: string | null;
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly expires_at: string | Date;
}

interface PersistedInvitation {
  readonly agencyId: string;
  readonly agencyName: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}

type AuditTargetType = 'agency' | 'invitation';

const recordAudit = async (
  transaction: AgencyCliTransaction,
  action: string,
  agencyId: string,
  targetType: AuditTargetType,
  targetId: string
): Promise<void> => {
  await transaction.query(
    `insert into audit.events
       (action, actor_user_id, agency_id, target_type, target_id, request_id)
     values (?, null, ?, ?, ?, ?)`,
    [action, agencyId, targetType, targetId, `agency-cli:${randomUUID()}`]
  );
};

const createInvitation = async (
  transaction: AgencyCliTransaction,
  agencyId: string,
  email: string
): Promise<{ invitation: InvitationRow; token: string }> => {
  const token = createInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const result = await transaction.query<InvitationRow>(
    `insert into public.invitations
       (agency_id, purpose, email, role_id, client_id, token_hash, expires_at,
        invited_by_user_id, accepted_by_user_id)
     values (?, 'agency_activation', ?, null, null, ?, now() + interval '7 days', null, null)
     returning id, email, expires_at`,
    [agencyId, email, tokenHash]
  );
  return { invitation: oneRow(result.rows, 'The activation invitation could not be created.'), token };
};

export interface AgencyCreateResult {
  readonly agencyId: string;
  readonly expiresAt: string;
}

export interface AgencyStatusResult {
  readonly agencyId: string;
  readonly status: 'active' | 'suspended';
}

export interface AgencyCommandService {
  create(input: { readonly name: string; readonly ownerEmail: string }): Promise<AgencyCreateResult>;
  suspend(agencyId: string): Promise<AgencyStatusResult>;
  reactivate(agencyId: string): Promise<AgencyStatusResult>;
  resendActivation(agencyId: string): Promise<AgencyCreateResult>;
}

export interface CreateAgencyCommandServiceOptions {
  readonly database: AgencyCliDatabase;
  readonly mailer: AgencyActivationMailer;
  readonly appPublicUrl: string;
}

export const createAgencyCommandService = (options: CreateAgencyCommandServiceOptions): AgencyCommandService => {
  const create = async (input: { readonly name: string; readonly ownerEmail: string }): Promise<AgencyCreateResult> => {
    const name = normalizeAgencyName(input.name);
    const email = normalizeEmail(input.ownerEmail);
    const persisted = await options.database.transaction(async (transaction): Promise<PersistedInvitation> => {
      const agencyResult = await transaction.query<AgencyRow>(
        `insert into public.agencies (name, status, owner_user_id)
         values (?, 'active', null)
         returning id, name`,
        [name]
      );
      const agency = oneRow(agencyResult.rows, 'The agency could not be created.');
      const { invitation, token } = await createInvitation(transaction, agency.id, email);
      await recordAudit(transaction, 'agency.created', agency.id, 'agency', agency.id);
      await recordAudit(transaction, 'invitation.sent', agency.id, 'invitation', invitation.id);
      return {
        agencyId: agency.id,
        agencyName: name,
        email,
        token,
        expiresAt: asIsoDate(invitation.expires_at)
      };
    });

    // The transaction is committed before this await. A delivery failure leaves the invitation
    // valid and therefore retryable through resend-activation.
    await options.mailer.sendActivationEmail({
      to: persisted.email,
      agencyName: persisted.agencyName,
      actionUrl: appUrlFor(options.appPublicUrl, persisted.token),
      expiresAt: persisted.expiresAt
    });
    return { agencyId: persisted.agencyId, expiresAt: persisted.expiresAt };
  };

  const changeStatus = async (
    agencyIdInput: string,
    status: 'active' | 'suspended',
    action: 'agency.suspended' | 'agency.reactivated'
  ): Promise<AgencyStatusResult> => {
    const agencyId = assertUuid(agencyIdInput);
    return options.database.transaction(async (transaction) => {
      const result = await transaction.query<AgencyRow>(
        'select id, status from public.agencies where id = ? for update',
        [agencyId]
      );
      const agency = oneRow(result.rows, 'Agency not found.');
      if (agency.status !== status) {
        await transaction.query(
          'update public.agencies set status = ?, updated_at = now() where id = ?',
          [status, agencyId]
        );
        await recordAudit(transaction, action, agencyId, 'agency', agencyId);
      }
      return { agencyId, status };
    });
  };

  const resendActivation = async (agencyIdInput: string): Promise<AgencyCreateResult> => {
    const agencyId = assertUuid(agencyIdInput);
    const persisted = await options.database.transaction(async (transaction): Promise<PersistedInvitation> => {
      const agencyResult = await transaction.query<AgencyRow>(
        'select id, name, status, owner_user_id from public.agencies where id = ? for update',
        [agencyId]
      );
      const agency = oneRow(agencyResult.rows, 'Agency not found.');
      if (agency.owner_user_id !== null && agency.owner_user_id !== undefined) {
        throw new AgencyCliError('The agency already has an owner; activation is no longer pending.');
      }
      // A suspended agency cannot have its invitations accepted, so resending would destroy the
      // pending invitation and mail a link that is invalid from the moment it is sent.
      if (agency.status !== 'active') {
        throw new AgencyCliError('The agency is suspended; reactivate it before resending the activation.');
      }

      const invitationResult = await transaction.query<InvitationRow>(
        `select id, email, expires_at
           from public.invitations
          where agency_id = ?
            and purpose = 'agency_activation'
            and used_at is null
            and revoked_at is null
          order by created_at desc
          limit 1
          for update`,
        [agencyId]
      );
      const oldInvitation = oneRow(invitationResult.rows, 'No pending activation invitation exists.');
      await transaction.query(
        'update public.invitations set revoked_at = now() where id = ?',
        [oldInvitation.id]
      );
      const { invitation, token } = await createInvitation(transaction, agencyId, normalizeEmail(oldInvitation.email));
      await recordAudit(transaction, 'invitation.revoked', agencyId, 'invitation', oldInvitation.id);
      await recordAudit(transaction, 'invitation.resent', agencyId, 'invitation', oldInvitation.id);
      await recordAudit(transaction, 'invitation.sent', agencyId, 'invitation', invitation.id);
      return {
        agencyId,
        agencyName: agency.name ?? '',
        email: normalizeEmail(oldInvitation.email),
        token,
        expiresAt: asIsoDate(invitation.expires_at)
      };
    });

    await options.mailer.sendActivationEmail({
      to: persisted.email,
      agencyName: persisted.agencyName,
      actionUrl: appUrlFor(options.appPublicUrl, persisted.token),
      expiresAt: persisted.expiresAt
    });
    return { agencyId: persisted.agencyId, expiresAt: persisted.expiresAt };
  };

  return {
    create,
    suspend: (agencyId) => changeStatus(agencyId, 'suspended', 'agency.suspended'),
    reactivate: (agencyId) => changeStatus(agencyId, 'active', 'agency.reactivated'),
    resendActivation
  };
};

const agencyCliEnvironmentSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().trim().min(1),
  SMTP_URL: z.string().trim().min(1),
  EMAIL_FROM: z.string().trim().min(1).max(320),
  APP_PUBLIC_URL: z.string().trim().min(1)
});

export interface AgencyCliEnvironment {
  readonly migrationDatabaseUrl: string;
  readonly smtpUrl: string;
  readonly emailFrom: string;
  readonly appPublicUrl: string;
}

const configurationError = (path: string, message: string): AgencyCliError =>
  new AgencyCliError(`Agency CLI configuration is invalid:\n- ${path}: ${message}\nConfiguration values are redacted.`);

const assertProtocol = (value: string, protocols: readonly string[], path: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(path, 'must be a valid URL.');
  }
  if (!protocols.includes(parsed.protocol)) {
    throw configurationError(path, `must use ${protocols.join(' or ')}.`);
  }
};

const normalizeAppPublicUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError('APP_PUBLIC_URL', 'must be a valid URL origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw configurationError('APP_PUBLIC_URL', 'must be an HTTP(S) origin without a path.');
  }
  return parsed.origin;
};

export const loadAgencyCliEnvironment = (environment: Record<string, string | undefined>): AgencyCliEnvironment => {
  const parsed = agencyCliEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw configurationError(String(issue?.path[0] ?? 'configuration'), issue?.message ?? 'is invalid.');
  }
  assertProtocol(parsed.data.MIGRATION_DATABASE_URL, ['postgres:', 'postgresql:'], 'MIGRATION_DATABASE_URL');
  assertProtocol(parsed.data.SMTP_URL, ['smtp:', 'smtps:'], 'SMTP_URL');
  try {
    assertEmailAddress('EMAIL_FROM', parsed.data.EMAIL_FROM);
  } catch {
    throw configurationError('EMAIL_FROM', 'must be a valid email address.');
  }
  return {
    migrationDatabaseUrl: parsed.data.MIGRATION_DATABASE_URL,
    smtpUrl: parsed.data.SMTP_URL,
    emailFrom: parsed.data.EMAIL_FROM,
    appPublicUrl: normalizeAppPublicUrl(parsed.data.APP_PUBLIC_URL)
  };
};

/** Uses the shared sender boundary; it never logs the action URL, token, or full recipient. */
export const createAgencyActivationMailer = (input: {
  readonly smtpUrl: string;
  readonly emailFrom: string;
}): AgencyActivationMailer => {
  const sender: EmailSender = createEmailSender({
    smtpUrl: input.smtpUrl,
    from: input.emailFrom,
    logger: createLogger({ enabled: false })
  });
  return {
    async sendActivationEmail(email): Promise<void> {
      const message = agencyActivationEmail({
        actionUrl: email.actionUrl,
        expiresInMinutes: INVITATION_EXPIRY_MINUTES,
        agencyName: email.agencyName
      });
      await sender.send({ ...message, to: email.to, template: 'agency-activation' });
    },
    close: sender.close
  };
};

type CreateArguments = { readonly command: 'create'; readonly name: string; readonly ownerEmail: string };
type AgencyIdArguments = { readonly command: 'suspend' | 'reactivate' | 'resend-activation'; readonly agencyId: string };
export type AgencyCliArguments = CreateArguments | AgencyIdArguments;

const usage = [
  'Usage:',
  '  node dist/cli/agency.js create --name "<name>" --owner-email "<email>"',
  '  node dist/cli/agency.js suspend --agency-id <uuid>',
  '  node dist/cli/agency.js reactivate --agency-id <uuid>',
  '  node dist/cli/agency.js resend-activation --agency-id <uuid>'
].join('\n');

const expectedOptions: Record<AgencyCliArguments['command'], readonly string[]> = {
  create: ['name', 'owner-email'],
  suspend: ['agency-id'],
  reactivate: ['agency-id'],
  'resend-activation': ['agency-id']
};

export const parseAgencyCliArguments = (argv: readonly string[]): AgencyCliArguments => {
  const command = argv[0];
  if (command !== 'create' && command !== 'suspend' && command !== 'reactivate' && command !== 'resend-activation') {
    throw new AgencyCliError(usage);
  }
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith('--')) throw new AgencyCliError(`Unexpected argument.\n${usage}`);
    const separator = argument.indexOf('=');
    const key = (separator === -1 ? argument.slice(2) : argument.slice(2, separator));
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!expectedOptions[command].includes(key)) throw new AgencyCliError(`Unknown option --${key}.\n${usage}`);
    if (options[key] !== undefined) throw new AgencyCliError(`Option --${key} was supplied more than once.`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.trim() === '' || (inlineValue === undefined && value.startsWith('--'))) {
      throw new AgencyCliError(`Option --${key} requires a value.`);
    }
    options[key] = value;
  }
  if (command === 'create') {
    const name = options.name;
    const ownerEmail = options['owner-email'];
    if (name === undefined) throw new AgencyCliError('Option --name is required.');
    if (ownerEmail === undefined) throw new AgencyCliError('Option --owner-email is required.');
    return { command, name, ownerEmail };
  }
  const agencyId = options['agency-id'];
  if (agencyId === undefined) throw new AgencyCliError('Option --agency-id is required.');
  return { command, agencyId };
};

export const formatAgencyCliOutput = (result: AgencyCreateResult | AgencyStatusResult): string =>
  `${JSON.stringify(result)}\n`;

export interface AgencyCliIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface RunAgencyCliOptions {
  readonly argv?: readonly string[];
  readonly environment?: Record<string, string | undefined>;
  readonly io?: AgencyCliIo;
  readonly database?: AgencyCliDatabase;
  readonly mailer?: AgencyActivationMailer;
}

export const runAgencyCli = async (options: RunAgencyCliOptions = {}): Promise<number> => {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  let database: AgencyCliDatabase | undefined = options.database;
  let mailer: AgencyActivationMailer | undefined = options.mailer;
  try {
    const args = parseAgencyCliArguments(options.argv ?? process.argv.slice(2));
    const environment = loadAgencyCliEnvironment(options.environment ?? process.env);
    database ??= createAgencyCliDatabase(environment.migrationDatabaseUrl);
    mailer ??= createAgencyActivationMailer({ smtpUrl: environment.smtpUrl, emailFrom: environment.emailFrom });
    const service = createAgencyCommandService({ database, mailer, appPublicUrl: environment.appPublicUrl });
    let result: AgencyCreateResult | AgencyStatusResult;
    if (args.command === 'create') result = await service.create({ name: args.name, ownerEmail: args.ownerEmail });
    else if (args.command === 'suspend') result = await service.suspend(args.agencyId);
    else if (args.command === 'reactivate') result = await service.reactivate(args.agencyId);
    else result = await service.resendActivation(args.agencyId);
    io.stdout.write(formatAgencyCliOutput(result));
    return 0;
  } catch (error) {
    const message = error instanceof AgencyCliError ? error.message : 'Agency command failed.';
    io.stderr.write(`${message}\n`);
    return 1;
  } finally {
    await mailer?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
  }
};

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void runAgencyCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
