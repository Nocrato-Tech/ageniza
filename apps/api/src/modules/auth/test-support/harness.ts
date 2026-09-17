import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import type { ApiConfig } from '@ageniza/config/server';
import { createLogger, type CoreLogger } from '@ageniza/core';
import { assertLocalDatabaseUrl, createLocalTestDatabaseClient, type DatabaseClient } from '@ageniza/database';
import type { EmailSender, OutgoingEmail } from '@ageniza/email';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../../../app.js';
import { createAuthAuditRecorder, type AuthAuditRecorder } from '../audit.js';
import { createAuthLimiter, type AuthLimiterOptions, type InMemoryAuthLimiter } from '../auth-limiter.js';
import { createAuth, type AuthInstance } from '../better-auth.js';
import { createEmailService, type EmailService } from '../email-service.js';

/** Runs only against the migrated local database (`pnpm db:migrate`), as the application role. */
export const APPLICATION_DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';
export const OWNER_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';

/** Test-only values; never a real secret and never committed anywhere else. */
export const TEST_APP_PUBLIC_URL = 'http://127.0.0.1:5173';
export const TEST_AUTH_SECRET = 'integration-test-secret-value-that-is-not-real';

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

/** Captures every log line written during a test so #15 can assert no secret ever reaches it. */
export const captureLogs = (): CapturedLogs => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    logger: createLogger({ level: 'debug' }, stream),
    lines: () => chunks,
    text: () => chunks.join('\n')
  };
};

export const buildTestConfig = (overrides: Partial<ApiConfig> = {}): ApiConfig => ({
  service: 'api',
  environment: 'test',
  databaseUrl: APPLICATION_DATABASE_URL,
  deployVersion: 'test',
  authSecret: TEST_AUTH_SECRET,
  appPublicUrl: TEST_APP_PUBLIC_URL,
  host: '127.0.0.1',
  port: 0,
  corsOrigins: [TEST_APP_PUBLIC_URL],
  bodyLimitBytes: 1_048_576,
  trustedProxyCidrs: [],
  ...overrides
});

export interface TestAppOptions {
  readonly config?: Partial<ApiConfig>;
  readonly sender?: EmailSender;
  readonly logger?: CoreLogger;
  readonly limiterOptions?: AuthLimiterOptions;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly pool: Pool;
  readonly auth: AuthInstance;
  readonly limiter: InMemoryAuthLimiter;
  readonly auditRecorder: AuthAuditRecorder;
  readonly emailService: EmailService;
  readonly config: ApiConfig;
  close(): Promise<void>;
}

/** Builds a fully-wired API app the same way `server.ts` does, with every dependency injected for tests. */
export const buildTestApp = async (options: TestAppOptions = {}): Promise<TestApp> => {
  assertLocalDatabaseUrl(APPLICATION_DATABASE_URL);
  const config = buildTestConfig(options.config);
  const pool = new Pool({ connectionString: APPLICATION_DATABASE_URL, max: 4 });
  const logger = options.logger ?? createLogger({ enabled: false });
  const sender = options.sender ?? createFakeEmailSender();
  const emailService = createEmailService({ sender, config: { appPublicUrl: config.appPublicUrl }, logger });
  const auditRecorder = createAuthAuditRecorder(pool);
  const auth = createAuth({ pool, config, sender: emailService, logger, auditRecorder });
  const limiter = createAuthLimiter(options.limiterOptions);
  const app = await buildApp({ config, logger, auth: { auth, limiter, auditRecorder } });
  await app.ready();

  return {
    app,
    pool,
    auth,
    limiter,
    auditRecorder,
    emailService,
    config,
    async close(): Promise<void> {
      await emailService.drain();
      await app.close();
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
