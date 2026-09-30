import { isIP } from 'node:net';

import knex, { type Knex } from 'knex';
import { Client } from 'pg';

/** Deliberately small limits: processes create their own client instead of sharing a global pool. */
export interface DatabasePoolSettings {
  readonly min: number;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly acquireTimeoutMillis: number;
}

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly pool?: Partial<DatabasePoolSettings>;
}

export interface DatabaseClient {
  readonly knex: Knex;
  readonly pool: DatabasePoolSettings;
  close(): Promise<void>;
  transaction<TResult>(work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult>;
}

export type SqlBinding = Knex.RawBinding;

const verifiedUserClaimsBrand = Symbol('verifiedUserClaims');

export interface VerifiedUserClaims {
  readonly userId: string;
  readonly [verifiedUserClaimsBrand]: true;
}

const defaultPool: DatabasePoolSettings = Object.freeze({
  min: 0,
  max: 4,
  idleTimeoutMillis: 10_000,
  acquireTimeoutMillis: 5_000
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertNonNegativeInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
};

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
};

const createPoolSettings = (overrides: Partial<DatabasePoolSettings> | undefined): DatabasePoolSettings => {
  const pool = { ...defaultPool, ...overrides };
  assertNonNegativeInteger('pool.min', pool.min);
  assertPositiveInteger('pool.max', pool.max);
  assertPositiveInteger('pool.idleTimeoutMillis', pool.idleTimeoutMillis);
  assertPositiveInteger('pool.acquireTimeoutMillis', pool.acquireTimeoutMillis);
  if (pool.min > pool.max) throw new Error('pool.max must be no smaller than pool.min.');
  return Object.freeze(pool);
};

const assertOpen = (closed: boolean): void => {
  if (closed) throw new Error('Database client has already been closed.');
};

/** Creates an explicit PostgreSQL Knex client. Call close during process shutdown. */
export const createDatabaseClient = (options: DatabaseClientOptions): DatabaseClient => {
  if (!options.connectionString) throw new Error('A database connection string is required.');

  const pool = createPoolSettings(options.pool);
  const client = knex({
    client: 'pg',
    connection: { connectionString: options.connectionString },
    pool: {
      min: pool.min,
      max: pool.max,
      idleTimeoutMillis: pool.idleTimeoutMillis,
      acquireTimeoutMillis: pool.acquireTimeoutMillis
    },
    acquireConnectionTimeout: pool.acquireTimeoutMillis
  });

  let closed = false;
  let closing: Promise<void> | undefined;

  return {
    knex: client,
    pool,
    async close(): Promise<void> {
      if (!closing) {
        closed = true;
        closing = client.destroy();
      }
      await closing;
    },
    transaction<TResult>(work: (transaction: Knex.Transaction) => Promise<TResult>): Promise<TResult> {
      assertOpen(closed);
      return client.transaction(work);
    }
  };
};

/**
 * Executes trusted SQL with values passed separately to Knex/pg. SQL structure must be authored
 * by application code; never interpolate request values into `statement`.
 */
export const raw = <TResult = unknown>(
  executor: Pick<Knex, 'raw'>,
  statement: string,
  bindings: readonly SqlBinding[]
): Knex.Raw<TResult> => executor.raw<TResult>(statement, bindings);

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
};

/**
 * Rejects non-local URLs so test helpers and local-only CLIs cannot accidentally target cloud or
 * production databases.
 *
 * The check reads the host the driver would actually connect to, not the URL's `hostname`: a
 * `?host=` query parameter (the Cloud SQL socket shape) overrides it, a socket path starts with
 * `/`, and a URL without a host falls back to `PGHOST`. `pg` ignores `hostaddr`, but it is
 * rejected outright so no future driver upgrade can silently start honouring it.
 */
export const assertLocalDatabaseUrl = (connectionString: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('Local/test database URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Local/test database URL must use a loopback PostgreSQL host.');
  }
  if (parsed.searchParams.has('hostaddr')) {
    throw new Error('Local/test database URL must not carry a hostaddr parameter.');
  }
  let effectiveHost: unknown;
  try {
    // Same parser the driver uses, including the environment fallbacks (PGHOST) it applies.
    // `connectionParameters` is runtime API, not part of `@types/pg`'s public surface.
    const parameters = (new Client(connectionString) as unknown as { connectionParameters: { host?: unknown } }).connectionParameters;
    effectiveHost = parameters.host;
  } catch {
    throw new Error('Local/test database URL must be a valid PostgreSQL URL.');
  }
  if (typeof effectiveHost !== 'string' || effectiveHost.startsWith('/') || !isLoopbackHost(effectiveHost)) {
    throw new Error('Local/test database URL must use a loopback PostgreSQL host.');
  }
};

/** Creates a client for the Docker-backed local development database only. */
export const createLocalTestDatabaseClient = (connectionString: string): DatabaseClient => {
  assertLocalDatabaseUrl(connectionString);
  return createDatabaseClient({ connectionString });
};

/**
 * Creates a narrow capability after an authentication boundary has verified the user's token.
 * Only a user id is carried into SQL: agency/tenant identity is intentionally never accepted here.
 */
export const createVerifiedUserClaims = (input: { readonly userId: string }): VerifiedUserClaims => {
  if (!uuidPattern.test(input.userId)) throw new Error('Verified user claims require a UUID user id.');
  return Object.freeze({ userId: input.userId, [verifiedUserClaimsBrand]: true as const });
};

/**
 * Publishes the verified user id as the transaction-local `app.user_id`, which RLS policies read
 * through `app_private.current_user_id()`. The connection must use the application role, which
 * cannot bypass RLS. This helper never accepts a tenant/agency id: policies derive tenant access
 * from memberships, and without this context the application role sees no tenant rows.
 */
export const withAuthenticatedUserTransaction = <TResult>(
  database: DatabaseClient,
  claims: VerifiedUserClaims,
  work: (transaction: Knex.Transaction) => Promise<TResult>
): Promise<TResult> => {
  if (claims[verifiedUserClaimsBrand] !== true) {
    throw new Error('Authenticated database transactions require verified user claims.');
  }

  return database.transaction(async (transaction) => {
    await raw(transaction, "select set_config('app.user_id', ?, true)", [claims.userId]);
    return work(transaction);
  });
};
