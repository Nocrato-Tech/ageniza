import { fileURLToPath } from 'node:url';

import knex from 'knex';

// Applies pending forward-only migrations as the database owner. Used by `pnpm db:migrate` and by
// the production migrations image; the API and worker never receive this connection string.
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  console.error('MIGRATION_DATABASE_URL is required.');
  process.exit(1);
}

const database = knex({ client: 'pg', connection: { connectionString }, pool: { min: 0, max: 1 } });
try {
  const [batch, applied] = await database.migrate.latest({
    directory: fileURLToPath(new URL('../migrations', import.meta.url)),
    loadExtensions: ['.mjs']
  });
  console.log(applied.length === 0 ? 'Database schema is up to date.' : `Applied migration batch ${batch}: ${applied.join(', ')}`);
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await database.destroy();
}
