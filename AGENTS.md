# Ageniza agent invariants

- `User` is global: never add `agency_id` to it.
- Owner is an Agency property, not a Role; tenant access is through memberships.
- Keep domain modules in `apps/api/src/modules`; `packages` is shared infrastructure only.
- Use Knex and parametrized SQL: do not add an ORM.
- Database changes use new migrations; never disable RLS.
- `service_role` must never reach the frontend.
- Do not invent business rules; GitHub Issues and approved Notion specs are authoritative.
- Before handoff, run relevant lint, typecheck, tests, and build checks.
