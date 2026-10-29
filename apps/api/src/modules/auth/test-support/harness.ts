import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ApiConfig, IdentityStorageConfig, StorageConfig } from '@ageniza/config/server';
import { createLogger, type CoreLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, type DatabaseClient, resolveIntegrationDatabaseUrls } from '@ageniza/database';
import type { EmailSender, OutgoingEmail } from '@ageniza/email';
import { createPaymentProvider, type PaymentProvider } from '@ageniza/payments';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';

import { buildApp, type ApiAppOptions } from '../../../app.js';
import type { AgencyModuleDependencies } from '../../agencies/routes.js';
import type { CollaboratorModuleDependencies } from '../../collaborators/routes.js';
import { createIdentityStorageClient, type IdentityStorageClient } from '../../identity-storage/storage-client.js';
import { createAuthAuditRecorder, type AuthAuditRecorder } from '../audit.js';
import { createAuthLimiter, type AuthLimiterOptions, type InMemoryAuthLimiter } from '../auth-limiter.js';
import { createAuth, type AuthInstance } from '../better-auth.js';
import { createEmailService, type EmailService } from '../email-service.js';
import { createRequireAgencyAccess, createRequireClientAccess, requireAnyPermission, requirePermission } from '../../tenancy/guards.js';
import { createInvitationTokenLookup, type InvitationModuleDependencies } from '../../invitations/routes.js';
import type { ClientModuleDependencies } from '../../clients/routes.js';
import { approvalCookieOptions } from '../../approval-links/policy.js';
import type { ApprovalLinkModuleDependencies } from '../../approval-links/routes.js';
import type { ContentPortalModuleDependencies } from '../../contents/portal-routes.js';
import type { ContentModuleDependencies } from '../../contents/routes.js';
import type { ContextModuleDependencies } from '../../contexts/routes.js';
import { createRequireSession } from '../session-guard.js';
import { createMediaJobDispatcher, type MediaJobDispatcher } from '../../media/job-dispatcher.js';
import type { MediaModuleDependencies } from '../../media/routes.js';
import { createMediaStorageClient, type MediaStorageClient } from '../../media/storage-client.js';
import type { LegalModuleDependencies } from '../../legal/routes.js';
import type { EmailChangeModuleDependencies } from '../../email-change/routes.js';
import type { StoryScriptModuleDependencies } from '../../story-scripts/routes.js';
import type { SubscriptionModuleDependencies } from '../../subscriptions/routes.js';
import type { ProfileModuleDependencies } from '../../profile/routes.js';

/** Runs only against your own migrated database (`pnpm db:migrate`), as the application role; never `ageniza`. */
const integrationUrls = resolveIntegrationDatabaseUrls();
export const APPLICATION_DATABASE_URL = integrationUrls.applicationUrl;
export const OWNER_DATABASE_URL = integrationUrls.ownerUrl;

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

/** Every pool of a test file holds at most this many connections: files run in parallel against one server whose budget is 97, and the races need two waiters and a holder (issue #792). */
const TEST_POOL_MAX = 3;

/** A test app that sits open until its file ends (auth.integration keeps 33) must not keep its idle connections: one file held 64 of the 97 the server has (issue #792). */
const TEST_POOL_IDLE_MS = 500;

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
  apiPublicUrl: 'http://127.0.0.1:3001',
  host: '127.0.0.1',
  port: 0,
  corsOrigins: [TEST_APP_PUBLIC_URL],
  mobileAppOrigins: [],
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
  /** The payment provider of the billing routes (#772): the simulated one by default, `null` for none, or a fake. */
  readonly paymentProvider?: PaymentProvider | null;
  /** The environment the billing routes believe they run in, to prove the simulated ones are left out in production. */
  readonly subscriptionsProduction?: boolean;
  /** Test-only route observer, forwarded to `buildApp` (issue #182 route-inventory test). */
  readonly onRoute?: ApiAppOptions['onRoute'];
  /**
   * Test-only wrapper around the harness's application-role client, so a test can observe the
   * statements a module sends through it (issue #304). Never used by production code.
   */
  readonly wrapDatabase?: (database: DatabaseClient) => DatabaseClient;
  /** Test-only clock of the contents module: the instant "today" is read from when a publication carries no day (issue #256). */
  readonly contentsClock?: () => Date;
  /**
   * Test-only wrapper around the identity storage the clients module signs photo URLs with, so a
   * test can make the bucket refuse a signature the way the real one does (issue #470).
   */
  readonly wrapIdentityStorage?: (storage: IdentityStorageClient) => IdentityStorageClient;
  /**
   * Test-only wrapper around the media storage that signs the download URLs (issue #593), so a test can count the signatures
   * a route makes or make the bucket refuse one. Never used by production code.
   */
  readonly wrapMediaStorage?: (storage: MediaStorageClient) => MediaStorageClient;
}

/** Real prehandler builders, wired to this test app's own `auth`/`database`, for `registerExtraRoutes`. */
export interface TestGuardBuilders {
  readonly requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** The session guard of the routes that answer an account whose e-mail is not confirmed, to test a later guard alone. */
  readonly requireSessionUnconfirmedAllowed: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  const pool = new Pool({ connectionString: APPLICATION_DATABASE_URL, max: TEST_POOL_MAX, idleTimeoutMillis: TEST_POOL_IDLE_MS });
  // A clone dropped under an idle pool (a file whose afterAll failed) must not become an uncaught 57P01.
  pool.on('error', () => undefined);
  const localDatabase = createLocalTestDatabaseClient(APPLICATION_DATABASE_URL, { max: TEST_POOL_MAX, idleTimeoutMillis: TEST_POOL_IDLE_MS });
  const database = options.wrapDatabase === undefined ? localDatabase : options.wrapDatabase(localDatabase);
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
  const agencies: AgencyModuleDependencies = {
    database,
    auth,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    ...(config.supportContactEmail === undefined ? {} : { supportContactEmail: config.supportContactEmail })
  };
  const clients: ClientModuleDependencies = config.identityStorage === undefined
    ? { database, auth, emailService, requireAgencyAccess: createRequireAgencyAccess({ database }), requirePermission, requireClientAccess, photoUrlExpirySeconds: 300 }
    : {
        database,
        auth,
        emailService,
        requireAgencyAccess: createRequireAgencyAccess({ database }),
        requirePermission,
        requireClientAccess,
        identityStorage: (options.wrapIdentityStorage ?? ((storage) => storage))(createIdentityStorageClient(config.identityStorage)),
        photoUrlExpirySeconds: config.identityStorage.downloadUrlExpirySeconds,
        photoMaxImageBytes: config.identityStorage.maxImageBytes
      };
  const contents: ContentModuleDependencies = {
    database,
    auth,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    ...(options.contentsClock === undefined ? {} : { now: options.contentsClock })
  };
  const collaborators: CollaboratorModuleDependencies | undefined = config.identityStorage === undefined ? undefined : {
    database,
    auth,
    identityStorage: createIdentityStorageClient(config.identityStorage),
    identityDownloadUrlExpirySeconds: config.identityStorage.downloadUrlExpirySeconds,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    requireAnyPermission
  };
  const ownedMediaJobDispatcher: MediaJobDispatcher | undefined = config.storage === undefined
    ? undefined
    : createMediaJobDispatcher({ connectionString: config.databaseUrl, logger: createLogger({ enabled: false }), poolIdleTimeoutMillis: TEST_POOL_IDLE_MS });
  if (ownedMediaJobDispatcher !== undefined) await ownedMediaJobDispatcher.start();
  const mediaJobs = ownedMediaJobDispatcher === undefined
    ? undefined
    : options.wrapMediaJobs?.(ownedMediaJobDispatcher) ?? ownedMediaJobDispatcher;
  const media: MediaModuleDependencies | undefined = config.storage === undefined ? undefined : {
    database,
    auth,
    storage: (options.wrapMediaStorage ?? ((storage) => storage))(createMediaStorageClient(config.storage)),
    config: config.storage,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    requireAnyPermission,
    jobs: mediaJobs
  };
  const contentPortal: ContentPortalModuleDependencies = {
    database,
    auth,
    requireClientAccess,
    ...(media === undefined ? {} : { media: { storage: media.storage, downloadUrlExpirySeconds: media.config.downloadUrlExpirySeconds } })
  };
  const approvalLinks: ApprovalLinkModuleDependencies = {
    database,
    cookie: approvalCookieOptions(config.apiPublicUrl),
    ...(media === undefined ? {} : { media: { storage: media.storage, downloadUrlExpirySeconds: media.config.downloadUrlExpirySeconds } })
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
  const legal: LegalModuleDependencies = {
    database,
    auth,
    config: { authTermsVersion: config.authTermsVersion, authPrivacyVersion: config.authPrivacyVersion }
  };
  const emailChange: EmailChangeModuleDependencies = { database, auth, emailService };
  const storyScripts: StoryScriptModuleDependencies = {
    database,
    auth,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    requireClientAccess
  };
  const authDependencies = {
    auth,
    limiter,
    auditRecorder,
    invitationTokenLookup,
    database,
    emailService,
    legalVersions: { terms: config.authTermsVersion, privacy: config.authPrivacyVersion },
    ...(config.google === undefined ? {} : { google: { appPublicUrl: config.appPublicUrl, mobileAppOrigins: config.mobileAppOrigins } })
  };
  const paymentProvider = options.paymentProvider === undefined
    ? await createPaymentProvider({ production: false, provider: 'simulado' })
    : options.paymentProvider ?? undefined;
  const subscriptions: SubscriptionModuleDependencies = {
    database,
    auth,
    requireAgencyAccess: createRequireAgencyAccess({ database }),
    requirePermission,
    production: options.subscriptionsProduction ?? false,
    ...(paymentProvider === undefined ? {} : { paymentProvider })
  };
  const app = await buildApp({
    config,
    logger,
    auth: authDependencies,
    invitations,
    contexts,
    agencies,
    clients,
    contents,
    contentPortal,
    approvalLinks,
    collaborators,
    media,
    profile,
    legal,
    emailChange,
    storyScripts,
    subscriptions,
    onRoute: options.onRoute,
    // A handler whose reply status drifts from its own `config.responseStatus` fails the request,
    // so the documented status is enforced by the suites, not only by the catalog.
    enforceDocumentedStatus: true
  });
  if (options.registerExtraRoutes !== undefined) {
    const guards: TestGuardBuilders = {
      requireSession: createRequireSession({ auth }),
      requireSessionUnconfirmedAllowed: createRequireSession({ auth }, { allowUnconfirmed: true }),
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
  /** Confirmed by default, like every account but a fresh public sign-up (issue #706). */
  readonly emailVerified?: boolean;
}

const passwordHashes = new Map<string, Promise<string>>();

/** A fixture hashes the same password dozens of times, and scrypt is what starves a file running beside others (issue #792). */
const hashOncePerPassword = (auth: AuthInstance, password: string): Promise<string> => {
  const known = passwordHashes.get(password);
  if (known !== undefined) return known;
  const hashed = auth.$context.then((context) => context.password.hash(password));
  passwordHashes.set(password, hashed);
  hashed.catch(() => passwordHashes.delete(password));
  return hashed;
};

/** Inserts a credential user directly into `auth.user`/`auth.account`, exactly as issue #31 prescribes. */
export const insertTestUser = async (pool: Pool, auth: AuthInstance, options: InsertTestUserOptions = {}): Promise<TestUserFixture> => {
  const id = randomUUID();
  const email = options.email ?? uniqueTestEmail(options.emailLabel ?? 'user');
  const password = options.password ?? 'a correct horse battery staple';
  const name = options.name ?? 'Integration Test User';
  const passwordHash = await hashOncePerPassword(auth, password);

  await pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, $4)', [id, name, email, options.emailVerified ?? true]);
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

export const ownerClient = (): DatabaseClient => createLocalTestDatabaseClient(OWNER_DATABASE_URL, { max: TEST_POOL_MAX, idleTimeoutMillis: TEST_POOL_IDLE_MS });

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
