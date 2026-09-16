# `@ageniza/database`

Server-only PostgreSQL/Supabase infrastructure. Knex is the sole query builder; there is no ORM. Applications create an explicit client with `createDatabaseClient`, use `database.transaction(...)`, and call `await database.close()` during their shutdown lifecycle.

For a local Docker-backed Supabase stack, use `createLocalTestDatabaseClient`. It refuses a non-loopback PostgreSQL URL, so tests cannot silently target a cloud project. `raw(executor, statement, bindings)` keeps values separate from SQL text; SQL structure remains authored application code and user input must always be a binding.

`withAuthenticatedUserTransaction` is for a request whose token was already verified by an authentication boundary. It sets only the fixed `authenticated` database role and the verified user id claims transaction-locally. It deliberately accepts no `agency_id` or tenant context, does not use `service_role`, and leaves RLS enabled.

The sole migration/policy history is [`supabase/migrations`](../../supabase/migrations). Do not create Knex migrations or put repositories, domain queries, or business rules in this package; those belong in `apps/api/src/modules`.
