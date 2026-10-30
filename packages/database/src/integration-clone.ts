import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import knex from 'knex';
import { Client } from 'pg';

/**
 * One migrated model database per integration run, and one clone of it per test file, so that the
 * files of a suite can run in parallel without ever sharing a row, a lock or a pg_stat_activity
 * entry (issue #792). The cluster-level roles (`ageniza_app`, ...) are shared by every clone, and
 * every grant and `search_path` the migrations set lives inside the database, so a clone carries
 * them; nothing here touches a role.
 */
export interface IntegrationModel {
  readonly runId: string;
  /** The database the operator pointed the suite at; it only supplies the server and the credentials. */
  readonly baseDatabase: string;
  readonly modelDatabase: string;
  readonly baseApplicationUrl: string;
  readonly baseOwnerUrl: string;
}

export interface IntegrationClone {
  readonly database: string;
  readonly applicationUrl: string;
  readonly ownerUrl: string;
  /** Drops the clone; safe to call twice, and it disconnects whatever the test file left open. */
  drop(): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,63}$/;

const quoteIdentifier = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new Error(`Refusing to use "${name}" as a database name.`);
  return `"${name}"`;
};

/** The same URL pointing at another database of the same server, with credentials and options untouched. */
export const withDatabaseName = (connectionString: string, database: string): string => {
  quoteIdentifier(database);
  const parsed = new URL(connectionString);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

const databaseNameOf = (connectionString: string): string => decodeURIComponent(new URL(connectionString).pathname.slice(1));

export const integrationModelName = (baseDatabase: string, runId: string): string => {
  const name = `${baseDatabase}_m${runId}`;
  quoteIdentifier(name);
  return name;
};

export const integrationCloneName = (baseDatabase: string, runId: string, suffix: string): string => {
  const name = `${integrationClonePrefix(baseDatabase, runId)}${suffix}`;
  quoteIdentifier(name);
  return name;
};

const integrationClonePrefix = (baseDatabase: string, runId: string): string => `${baseDatabase}_c${runId}_`;

const withAdministrator = async <TResult>(ownerUrl: string, work: (client: Client) => Promise<TResult>): Promise<TResult> => {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const dropDatabase = (client: Client, name: string): Promise<unknown> =>
  client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);

/**
 * Creates the model database and applies every migration to it. Runs once per suite, as the owner,
 * against the server the two URLs point at; the database those URLs name is never written to. The URLs
 * come from `resolveIntegrationDatabaseUrls`, which refuses the owner's development database.
 */
export const createIntegrationModel = async (urls: { readonly applicationUrl: string; readonly ownerUrl: string }): Promise<IntegrationModel> => {
  const { applicationUrl, ownerUrl } = urls;
  const baseDatabase = databaseNameOf(ownerUrl);
  const runId = randomBytes(3).toString('hex');
  const modelDatabase = integrationModelName(baseDatabase, runId);
  await withAdministrator(ownerUrl, (client) => client.query(`create database ${quoteIdentifier(modelDatabase)}`));
  const migrations = knex({
    client: 'pg',
    connection: { connectionString: withDatabaseName(ownerUrl, modelDatabase) },
    pool: { min: 0, max: 1 }
  });
  try {
    await migrations.migrate.latest({
      directory: fileURLToPath(new URL('../migrations', import.meta.url)),
      loadExtensions: ['.mjs']
    });
  } catch (error) {
    await migrations.destroy();
    await withAdministrator(ownerUrl, (client) => dropDatabase(client, modelDatabase));
    throw error;
  }
  await migrations.destroy();
  return { runId, baseDatabase, modelDatabase, baseApplicationUrl: applicationUrl, baseOwnerUrl: ownerUrl };
};

const OBJECT_IN_USE = '55006';
const CLONE_ATTEMPTS = 5;

/** `create database ... template` refuses while any session is connected to the template, so a refusal is retried. */
export const cloneIntegrationDatabase = async (model: IntegrationModel): Promise<IntegrationClone> => {
  const database = integrationCloneName(model.baseDatabase, model.runId, randomBytes(4).toString('hex'));
  await withAdministrator(model.baseOwnerUrl, async (client) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.query(`create database ${quoteIdentifier(database)} template ${quoteIdentifier(model.modelDatabase)}`);
        return;
      } catch (error) {
        if (attempt >= CLONE_ATTEMPTS || (error as { code?: unknown }).code !== OBJECT_IN_USE) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  });
  let dropped = false;
  return {
    database,
    applicationUrl: withDatabaseName(model.baseApplicationUrl, database),
    ownerUrl: withDatabaseName(model.baseOwnerUrl, database),
    async drop(): Promise<void> {
      if (dropped) return;
      dropped = true;
      await withAdministrator(model.baseOwnerUrl, (client) => dropDatabase(client, database));
    }
  };
};

/** Drops the model and every clone of this run that a crashed worker did not drop. */
export const dropIntegrationDatabases = async (model: IntegrationModel): Promise<void> => {
  await withAdministrator(model.baseOwnerUrl, async (client) => {
    const leftovers = await client.query<{ datname: string }>(
      'select datname from pg_catalog.pg_database where starts_with(datname, $1)',
      [integrationClonePrefix(model.baseDatabase, model.runId)]
    );
    for (const { datname } of leftovers.rows) await dropDatabase(client, datname);
    await dropDatabase(client, model.modelDatabase);
  });
};

export interface ConnectionWatch {
  /** Stops sampling and returns the most connections the clone ever held at one sample. */
  stop(): Promise<{ readonly peak: number }>;
}

/**
 * Counts the connections of a clone while its file runs, from a connection of its own to the operator's database, so
 * the watcher is neither counted nor holds the clone. Files run side by side against one server whose connection budget
 * is shared (97 for non-superusers): a file that holds more than its share refuses the others with SQLSTATE 53300 at
 * random, and this turns that into a failure of the file that held them.
 */
export const watchConnections = async (model: IntegrationModel, clone: Pick<IntegrationClone, 'database'>, intervalMs = 200): Promise<ConnectionWatch> => {
  const client = new Client({ connectionString: model.baseOwnerUrl });
  await client.connect();
  let peak = 0;
  let stopped = false;
  const sample = async (): Promise<void> => {
    const result = await client.query<{ count: number }>(
      'select count(*)::int as count from pg_catalog.pg_stat_activity where datname = $1 and pid <> pg_catalog.pg_backend_pid()',
      [clone.database]
    );
    peak = Math.max(peak, Number(result.rows[0]?.count));
  };
  const loop = (async () => {
    while (!stopped) {
      await sample().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      await sample().catch(() => undefined);
      await client.end().catch(() => undefined);
      return { peak };
    }
  };
};
