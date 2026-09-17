# `@ageniza/database`

Server-only PostgreSQL infrastructure ([ADR 0011](../../docs/adr/0011-self-hosted-postgres-and-better-auth.md)). Knex is the sole query builder; there is no ORM. Applications create an explicit client with `createDatabaseClient`, use `database.transaction(...)`, and call `await database.close()` during their shutdown lifecycle.

For the local Docker database, use `createLocalTestDatabaseClient`. It refuses a non-loopback PostgreSQL URL, so tests cannot silently target a remote database. `raw(executor, statement, bindings)` keeps values separate from SQL text; SQL structure remains authored application code and user input must always be a binding.

## Roles and RLS

- `ageniza_app` is the only role the API and worker use. It is created when the data volume is initialised ([`infra/postgres/initdb`](../../infra/postgres/initdb)) and is neither superuser nor `BYPASSRLS`. Migrations grant it table privileges.
- The owner role (`postgres`) runs migrations only, through `MIGRATION_DATABASE_URL`.
- `withAuthenticatedUserTransaction` is for a request whose user was already verified by the authentication boundary. It sets the transaction-local `app.user_id`, which policies read through `app_private.current_user_id()`. It deliberately accepts no `agency_id`: policies derive tenant access from memberships. Without it, the application role sees no tenant rows.
- Multi-tenant tables use `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- The `pgboss` schema holds the worker's durable job queue. Its migration freezes pg-boss's own SQL and grants `ageniza_app` data access only, with no `CREATE`; the worker never runs DDL there ([worker README](../../apps/worker/README.md#durable-jobs)). Never edit that migration: upgrade pg-boss with a new one.

### Every table in `public` needs RLS

The foundation migration grants default privileges on `public` to `ageniza_app`, so a table created by a later migration is readable and writable by the application role as soon as it exists. RLS is not automatic in the same way, and a migration that forgets it hands out unrestricted cross-tenant access silently.

`pnpm db:test:local` therefore asserts, against the migrated schema, that every ordinary and partitioned table in `public` has both `relrowsecurity` and `relforcerowsecurity`. `FORCE` is required as well as `ENABLE`: without it the owner bypasses its own policies. The check runs in the `PostgreSQL local database` CI job, so a migration that creates a table without RLS fails the pull request.

A table that genuinely holds no tenant data is allowed through only by adding it, with its reason, to `PUBLIC_TABLES_EXEMPT_FROM_RLS` in [`test/support/rls-coverage.ts`](test/support/rls-coverage.ts). Today that list holds only Knex's own `knex_migrations` and `knex_migrations_lock`. An exemption that stops matching a table also fails, so the list cannot rot. Components that own their schema — the job queue, for example — are outside `public` and are covered by their own policies instead.

## Migrations

Migrations live in [`migrations`](migrations) as forward-only Knex `.mjs` files named `<8+ digit version>_<name>.mjs`, with explicit SQL in `knex.raw`. Never edit an applied migration; CI rejects edits, deletions, and renames. `down` throws on purpose.

```sh
pnpm db:start     # local PostgreSQL 17 on 127.0.0.1:54322
pnpm db:migrate   # apply pending migrations as the local owner
pnpm db:reset     # delete the local volume and rebuild from migrations
pnpm db:test:local
```

Production runs the same migrations from the `ageniza-migrations` image before any container changes. Do not put repositories, domain queries, or business rules in this package; those belong in `apps/api/src/modules`.
