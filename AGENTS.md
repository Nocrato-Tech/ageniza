# Ageniza agent invariants

- `User` is global: never add `agency_id` to it.
- Owner is an Agency property, not a Role; tenant access is through memberships.
- Keep domain modules in `apps/api/src/modules`; `packages` is shared infrastructure only.
- Use Knex and parametrized SQL: do not add an ORM.
- Database changes use new Knex migrations; never edit an applied one and never disable RLS.
- PostgreSQL is self-hosted (ADR 0011): the application role never bypasses RLS, and user/tenant context reaches policies through per-transaction `SET LOCAL`, not `auth.uid()`.
- Database credentials, auth secrets, and storage keys must never reach the frontend or the repository.
- Never publish the PostgreSQL port; Docker-published ports bypass the firewall.
- Do not invent business rules; GitHub Issues and approved Notion specs are authoritative.
- Before handoff, run relevant lint, typecheck, tests, and build checks.
- Never push to `main` or `develop` (not even with `--no-verify`); work on a branch and open a pull request.
