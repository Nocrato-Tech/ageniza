import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ApiConfig, IdentityStorageConfig, StorageConfig } from '@ageniza/config/server';
import { createLogger, type CoreLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, type DatabaseClient } from '@ageniza/database';
import type { EmailSender, OutgoingEmail } from '@ageniza/email';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';

import { buildApp, type ApiAppOptions } from '../../../app.js';
import type { AgencyModuleDependencies } from '../../agencies/routes.js';
import type { CollaboratorModuleDependencies } from '../../collaborators/routes.js';
import { createIdentityStorageClient } from '../../identity-storage/storage-client.js';
import { createAuthAuditRecorder, type AuthAuditRecorder } from '../audit.js';
import { createAuthLimiter, type AuthLimiterOptions, type InMemoryAuthLimiter } from '../auth-limiter.js';
import { createAuth, type AuthInstance } from '../better-auth.js';
import { createEmailService, type EmailService } from '../email-service.js';
import { createRequireAgencyAccess, createRequireClientAccess, requirePermission } from '../../tenancy/guards.js';
import { createInvitationTokenLookup, type InvitationModuleDependencies } from '../../invitations/routes.js';
import type { ClientModuleDependencies } from '../../clients/routes.js';
import type { ContextModuleDependencies } from '../../contexts/routes.js';
import { countValidContexts } from '../../contexts/service.js';
import { createRequireSession } from '../session-guard.js';
import { createMediaJobDispatcher, type MediaJobDispatcher } from '../../media/job-dispatcher.js';
import type { MediaModuleDependencies } from '../../media/routes.js';
import { createMediaStorageClient } from '../../media/storage-client.js';
import type { ProfileModuleDependencies } from '../../profile/routes.js';

/** Runs only against the migrated local database (`pnpm db:migrate`), as the application role. */
export const APPLICATION_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';
export const OWNER_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

/** Test-only values; never a real secret and never committed anywhere else. */
export const TEST_APP_PUBLIC_URL = 'http://127.0.0.1:5173';
export const TEST_AUTH_SECRET = 'integration-test-secret-value-that-is-not-real';

const localStorageCredentials = (): { accessKeyId: string; secretAccessKey: string } => {
  if (process.env.R2_ACCESS_KEY_ID !== undefined && process.env.R2_SECRET_ACCESS_KEY !== undefined) {
    return { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY };
  }
  const values = Object.fromEntries(readFileSync(resolve(process.cwd(), '../../.local/storage.env'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  if (values.R2_ACCESS_KEY_ID === undefined || values.R2_SECRET_ACCESS_KEY === undefined) {
    throw new Error('Run pnpm storage:start before API integration tests.');
  }
  return { accessKeyId: values.R2_ACCESS_KEY_ID, secretAccessKey: values.R2_SECRET_ACCESS_KEY };
};

const testStorageCredentials = localStorageCredentials();

export const runPrefix = (): string => `authtest-${randomUUID().slice(0, 8)}`;

/** A unique, obviously-fake local email per test run/case, so parallel and repeated CI runs never collide. */
export const uniqueTestEmail = (label: string): string => `${label}.${randomUUID().slice(0, 8)}@auth-integration.test`;

export interface FakeEmailSender extends EmailSender {
  readonly sent: OutgoingEmail[];
}

/** A fake at the `EmailSender` seam (see `packages/email/src/index.ts`), same seam `email-service.test.ts` uses. */
export const createFakeEmailSender = (send?: EmailSender['send']): FakeEmailSender => {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    send: send ?? (async (message) => { sent.push(message); }),
    close: async () => undefined
  };
};

export interface CapturedLogs {
  readonly logger: CoreLogger;
  lines(): readonly string[];
  text(): string;
}

/** Captures every log line written during a test so #15 can assert no secret ever reaches it.
 * The level is configurable because a suite that runs real logins pays for debug serialization it
 * does not need; the default keeps the auth tests' behavior. */
export const captureLogs = (level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): CapturedLogs => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    logger: createLogger({ level }, stream),
    lines: () => chunks,
    text: () => chunks.join('\n')
  };
};

/** Points at the Compose LocalStack started by `pnpm storage:start` (issue #21).
 * Integration tests that never reach the media module still pay nothing extra for this: the
 * client is only constructed, never connected to, until a route actually calls it. */
export const TEST_STORAGE_CONFIG: StorageConfig = {
  endpoint: process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  publicEndpoint: process.env.R2_PUBLIC_ENDPOINT ?? process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'auto',
  accessKeyId: testStorageCredentials.accessKeyId,
  secretAccessKey: testStorageCredentials.secretAccessKey,
  bucket: process.env.R2_BUCKET ?? 'ageniza-media-local',
  forcePathStyle: true,
  uploadUrlExpirySeconds: 900,
  downloadUrlExpirySeconds: 300,
  multipartThresholdBytes: 8 * 1024 * 1024,
  multipartPartBytes: 8 * 1024 * 1024,
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 5 * 1024 * 1024 * 1024,
  quotaDefaultBytes: 10 * 1024 * 1024 * 1024,
  quotaDefaultObjectCount: 2_000
};

/** Points at the same local LocalStack, but a distinct bucket (issue #100) -- identity storage
 * is never the media bucket, and config loading refuses to start otherwise (`server.test.ts`). */
export const TEST_IDENTITY_STORAGE_CONFIG: IdentityStorageConfig = {
  endpoint: process.env.IDENTITY_STORAGE_ENDPOINT ?? process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  publicEndpoint: process.env.IDENTITY_STORAGE_PUBLIC_ENDPOINT ?? process.env.IDENTITY_STORAGE_ENDPOINT ?? process.env.R2_PUBLIC_ENDPOINT ?? process.env.R2_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: 'auto',
  accessKeyId: testStorageCredentials.accessKeyId,
  secretAccessKey: testStorageCredentials.secretAccessKey,
  bucket: process.env.IDENTITY_STORAGE_BUCKET ?? 'ageniza-identity-local',
  forcePathStyle: true,
  downloadUrlExpirySeconds: 300,
  maxImageBytes: 5 * 1024 * 1024
};

export const buildTestConfig = (overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  service: 'api',
  environment: 'test',
  databaseUrl: APPLICATION_DATABASE_URL,
  storage: TEST_STORAGE_CONFIG,
  identityStorage: TEST_IDENTITY_STORAGE_CONFIG,
  deployVersion: 'test',
  authSecret: TEST_AUTH_SECRET,
  appPublicUrl: TEST_APP_PUBLIC_URL,
  host: '127.0.0.1',
  port: 0,
  corsOrigins: [TEST_APP_PUBLIC_URL],
  bodyLimitBytes: 1_048_576,
  trustedProxyCidrs: [],
  containerLocal: false,
  authTermsVersion: '2026-01-01',
  authPrivacyVersion: '2026-01-01',
  ...overrides
});

export interface TestAppOptions {
  readonly config?: Partial<ApiConfig>;
  readonly sender?: EmailSender;
  readonly logger?: CoreLogger;
  readonly limiterOptions?: AuthLimiterOptions;
  /** Test-only wrapper for simulating queue failures while retaining the real dispatcher. */
  readonly wrapMediaJobs?: (jobs: MediaJobDispatcher) => MediaJobDispatcher;
  /**
   * Test/harness-only hook (B12 #13, AUTH-20C #14): registers additional routes on the built app,
   * outside the auth module, before `app.ready()`. Never used by production code. Exists so a
   * test can prove the global origin/CSRF check covers a real route it does not otherwise know
   * about, and so AUTH-20C's "two tabs" test can mount a route guarded by the real
   * `requireAgencyAccess`/`requireClientAccess` prehandlers without a bespoke fixture.
   */
  readonly registerExtraRoutes?: (app: FastifyInstance, guards: TestGuardBuilders) => void | Promise<void>;
  /**
   * Overrides the real `countValidContexts` the auth module is normally wired with. Exists so a
   * test can deterministically simulate the context-count lookup failing (2026-09-29 security
   * review of PR #176, achado 2) without relying on a real, hard-to-trigger database error.
   */
  readonly countValidContexts?: (userId: string) => Promise<number>;
  /** Test-only route observer, forwarded to `buildApp` (issue #182 route-inventory test). */
  readonly onRoute?: ApiAppOptions['onRoute'];
}

/** Real prehandler builders, wired to this test app's own `auth`/`database`, for `registerExtraRoutes`. */
export interface TestGuardBuilders {
  readonly requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAgencyAccess: (request: FastifyRequest) => Promise<void>;
  readonly requireClientAccess: (request: FastifyRequest) => Promise<void>;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly pool: Pool;
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
  readonly database: DatabaseClient;
  readonly emailService: EmailService;
  readonly config: ApiConfig;
  readonly media?: MediaModuleDependencies;
  close(): Promise<void>;
}

/** Builds a fully-wired API app the same way `server.ts` does, with every dependency injected for tests. */
export const buildTestApp = async (options: TestAppOptions = {}): Promise<TestApp> => {
  assertLocalDatabaseUrl(APPLICATION_DATABASE_URL);
  const config = buildTestConfig(options.config);
  const pool = new Pool({ connectionString: APPLICATION_DATABASE_URL, max: 4 });
  const database = createLocalTestDatabaseClient(APPLICATION_DATABASE_URL);
  const logger = options.logger ?? createLogger({ enabled: false });
  const sender = options.sender ?? createFakeEmailSender();
  const emailService = createEmailService({ sender, config: { appPublicUrl: config.appPublicUrl }, logger });
  const auditRecorder = createAuthAuditRecorder(pool);
  const auth = createAuth({ pool, config, sender: emailService, logger, auditRecorder });
  const limiter = createAuthLimiter(options.limiterOptions);
  const invitationTokenLookup = createInvitationTokenLookup(database);
  const invitations: InvitationModuleDependencies = {
    database,
    auth,
    emailService,
    auditRecorder,
    config: {
      appPublicUrl: config.appPublicUrl,
      authTermsVersion: config.authTermsVersion,
      authPrivacyVersion: config.authPrivacyVersion
    },
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    invitationTokenLookup
  };
  const requireClientAccess = createRequireClientAccess({ database });
  const contexts: ContextModuleDependencies = { database, auth, requireClientAccess };
  const agencies: AgencyModuleDependencies = { database, auth, requireAgencyAccess: createRequireAgencyAccess({ database }) };
  const clients: ClientModuleDependencies = config.identityStorage === undefined
    ? { database, auth, requireAgencyAccess: createRequireAgencyAccess({ database }), requirePermission, photoUrlExpirySeconds: 300 }
    : {
        database,
        auth,
        requireAgencyAccess: createRequireAgencyAccess({ database }),
        requirePermission,
        identityStorage: createIdentityStorageClient(config.identityStorage),
        photoUrlExpirySeconds: config.identityStorage.downloadUrlExpirySeconds
      };
  const collaborators: CollaboratorModuleDependencies | undefined = config.identityStorage === undefined ? undefined : {
    database,
    auth,
    identityStorage: createIdentityStorageClient(config.identityStorage),
    identityDownloadUrlExpirySeconds: config.identityStorage.downloadUrlExpirySeconds,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission
  };
  const ownedMediaJobDispatcher: MediaJobDispatcher | undefined = config.storage === undefined
    ? undefined
    : createMediaJobDispatcher({ connectionString: config.databaseUrl, logger: createLogger({ enabled: false }) });
  if (ownedMediaJobDispatcher !== undefined) await ownedMediaJobDispatcher.start();
  const mediaJobs = ownedMediaJobDispatcher === undefined
    ? undefined
    : options.wrapMediaJobs?.(ownedMediaJobDispatcher) ?? ownedMediaJobDispatcher;
  const media: MediaModuleDependencies | undefined = config.storage === undefined ? undefined : {
    database,
    auth,
    storage: createMediaStorageClient(config.storage),
    config: config.storage,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    jobs: mediaJobs
  };
  const profile: ProfileModuleDependencies | undefined = config.identityStorage === undefined ? undefined : {
    database,
    auth,
    identityStorage: createIdentityStorageClient(config.identityStorage),
    config: {
      maxImageBytes: config.identityStorage.maxImageBytes,
      downloadUrlExpirySeconds: config.identityStorage.downloadUrlExpirySeconds
    }
  };
  const authDependencies = {
    auth,
    limiter,
    auditRecorder,
    invitationTokenLookup,
    countValidContexts: options.countValidContexts ?? ((userId: string) => countValidContexts(database, userId))
  };
  const app = await buildApp({
    config,
    logger,
    auth: authDependencies,
    invitations,
    contexts,
    agencies,
    clients,
    collaborators,
    media,
    profile,
    onRoute: options.onRoute,
    // A handler whose reply status drifts from its own `config.responseStatus` fails the request,
    // so the documented status is enforced by the suites, not only by the catalog.
    enforceDocumentedStatus: true
  });
  if (options.registerExtraRoutes !== undefined) {
    const guards: TestGuardBuilders = {
      requireSession: createRequireSession({ auth }),
      requireAgencyAccess: createRequireAgencyAccess({ database }),
      requireClientAccess
    };
    await options.registerExtraRoutes(app, guards);
  }
  await app.ready();

  return {
    app,
    pool,
    auth,
    limiter,
    auditRecorder,
    emailService,
    database,
    config,
    media,
    async close(): Promise<void> {
      await emailService.drain();
      await ownedMediaJobDispatcher?.stop();
      await app.close();
      await database.close();
      await pool.end();
    }
  };
};

export interface TestUserFixture {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export interface InsertTestUserOptions {
  readonly emailLabel?: string;
  readonly email?: string;
  readonly password?: string;
  readonly name?: string;
}

/** Inserts a credential user directly into `auth.user`/`auth.account`, exactly as issue #31 prescribes. */
export const insertTestUser = async (pool: Pool, auth: AuthInstance, options: InsertTestUserOptions = {}): Promise<TestUserFixture> => {
  const id = randomUUID();
  const email = options.email ?? uniqueTestEmail(options.emailLabel ?? 'user');
  const password = options.password ?? 'a correct horse battery staple';
  const name = options.name ?? 'Integration Test User';
  const passwordHash = await (await auth.$context).password.hash(password);

  await pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)', [id, name, email]);
  await pool.query(
    'insert into auth."account" (id, "accountId", "providerId", "userId", password, "updatedAt") values ($1, $2, $3, $4, $5, now())',
    [randomUUID(), id, 'credential', id, passwordHash]
  );

  return { id, email, password, name };
};

/** Deletes a test user and everything that cascades from it (`auth.session`, `auth.account`). */
export const deleteTestUser = async (pool: Pool, userId: string): Promise<void> => {
  await pool.query('delete from auth."user" where id = $1', [userId]);
};

/**
 * Deletes leftover `auth.verification` rows for one test user. Password-reset verification rows
 * store the user id (not the token) in `value`, so this works even though `storeIdentifier:
 * 'hashed'` means the identifier column never holds the raw, human-readable token.
 */
export const deleteVerificationsForUser = async (pool: Pool, userId: string): Promise<void> => {
  await pool.query('delete from auth.verification where value = $1', [userId]);
};

/** Cleans up everything this fixture may have created: pending verifications, then the user itself
 * (which cascades to `auth.session` and `auth.account`). */
export const cleanupTestUser = async (pool: Pool, userId: string): Promise<void> => {
  await deleteVerificationsForUser(pool, userId);
  await deleteTestUser(pool, userId);
};

export const ownerClient = (): DatabaseClient => createLocalTestDatabaseClient(OWNER_DATABASE_URL);

/**
 * Grants a user exactly one context — ownership of a freshly created agency — so a test login or
 * `resolve` call is not rejected by the zero-context rule (issue #68). `public.agencies` has no
 * insert policy for the application role, so this goes through the migration owner, same as every
 * other test file's own `createAgency` helper. Returns the agency id, for `cleanupOwnedAgencyContext`.
 */
export const grantOwnedAgencyContext = async (userId: string, name = 'Auth Test Agency'): Promise<string> => {
  const id = randomUUID();
  await queryAsOwner('insert into public.agencies (id, name, owner_user_id, status) values ($1, $2, $3, $4)', [
    id, `${name} ${id.slice(0, 8)}`, userId, 'active'
  ]);
  return id;
};

/**
 * Cleans up an agency created by `grantOwnedAgencyContext`. Clears `owner_user_id` first: that
 * column has no `on delete` action, so a still-owned agency would block deleting the user.
 */
export const cleanupOwnedAgencyContext = async (agencyId: string): Promise<void> => {
  await queryAsOwner('update public.agencies set owner_user_id = null where id = $1', [agencyId]);
  await queryAsOwner('delete from public.agencies where id = $1', [agencyId]);
};

/**
 * Reads with the migration owner role, never the application role: `ageniza_app` only has
 * `insert` on `audit.events` (by design, see the module README), so verifying an audited event
 * from a test must go through the owner instead of the app pool the rest of a test uses.
 */
export const queryAsOwner = async <TRow extends object>(sql: string, params: readonly unknown[] = []): Promise<TRow[]> => {
  const pool = new Pool({ connectionString: OWNER_DATABASE_URL, max: 1 });
  try {
    const result = await pool.query<TRow>(sql, Array.from(params));
    return result.rows;
  } finally {
    await pool.end();
  }
};
