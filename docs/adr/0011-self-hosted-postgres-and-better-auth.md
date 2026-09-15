# ADR 0011: Self-hosted PostgreSQL and Better Auth instead of Supabase

- Status: Accepted
- Date: 2026-09-15
- Deciders: Ageniza maintainers
- Issue: [#16](https://github.com/Nocrato-Tech/ageniza/issues/16)
- Supersedes: the Supabase parts of the Arquitetura de Solução v1, ADR 0010 references to Supabase, and issue #5's "PostgreSQL/Supabase" scope

## Context

The foundation was built on Supabase: managed PostgreSQL, Supabase Auth, Supabase Storage, and RLS policies based on `auth.uid()`. Local development used the Supabase CLI.

The team wants direct control of the database and infrastructure, and does not want a per-project platform fee before the product has paying customers. Authentication has not been implemented yet: today Supabase is referenced only by configuration, the local database tooling, one integration test, and the web login shell. This is the cheapest point to change providers.

## Decision

- **Database:** PostgreSQL 17 in Docker. Locally and in CI it runs as a container; in production it runs on the Hostinger VPS inside the application's Docker network, with no published port (Docker-published ports bypass UFW) and a persistent volume.
- **Migrations:** Knex migrations, versioned in the repository. SQL stays explicit where it is clearer, and there is still no ORM. Applied migrations are never edited.
- **Database roles:** a migration/owner role separate from an application role that is neither superuser nor `BYPASSRLS`. Multi-tenant tables use `FORCE ROW LEVEL SECURITY`.
- **RLS context:** the API authenticates the request and sets the user and tenant for each transaction with `SET LOCAL` (for example `app.user_id`); policies read those settings instead of `auth.uid()`. RLS remains an independent barrier behind backend authorization.
- **Authentication:** Better Auth in the API, storing its tables in the project database through versioned migrations. Email and password with cookie sessions, verification, and password reset. Public signup stays disabled; entry is by invitation and activation as the authentication specification defines. `User` stays global, without `agency_id`.
- **Files:** Cloudflare R2 (S3-compatible), private buckets, short-lived signed URLs issued only after tenant and capability checks. MinIO replaces it locally.
- **Email:** a single transactional sending path; Mailpit locally, a production provider chosen in issue #19.
- **Backups:** daily encrypted `pg_dump` from the VPS to R2 with retention, alerting, and a tested restore, completed before production holds real data (issue #18).

## Alternatives considered

### Supabase Free, then Pro

Keeps backups, Auth, and Storage managed, at US$ 25/month once real customers arrive (Free has no backups and pauses inactive projects). Rejected because the team explicitly wants to own the database and infrastructure; the fee alone would not have justified the change.

### Self-hosted Supabase

Keeps the Supabase APIs but means operating around ten containers and substantially more memory on a single VPS, while still owning backups and upgrades. It combines the operational cost of self-hosting with the coupling of the platform.

### Postgres with another auth library or custom auth

Better Auth already provides password hashing, sessions, verification, reset, and rate limiting, and works with a plain PostgreSQL connection. Custom authentication would re-implement security-sensitive code without a product benefit.

## Consequences

- The team now operates the database: backups with tested restores, PostgreSQL upgrades, disk and memory monitoring, and credential rotation. The database and the application share one VPS, so losing the VPS takes both down until restore; the recovery point is the last daily backup (24 hours in the MVP).
- Invitation, activation, and membership flows are implemented by the team on top of Better Auth. Transactional email is a new dependency.
- Local development no longer needs the Supabase CLI; Docker alone brings up PostgreSQL, MinIO, and Mailpit.
- Production credentials for the database, Better Auth, R2, and email exist only in root-owned files on the VPS, following the ADR 0010 amendment.
- **Human action required before implementing authentication:** update the Arquitetura de Solução v1 (data, authentication, storage, deploy) and the Especificação Técnica de Autenticação v1 in Notion so they no longer describe Supabase.

## Implementation issues

| Issue | Scope |
| --- | --- |
| [#17](https://github.com/Nocrato-Tech/ageniza/issues/17) | PostgreSQL in Docker, Knex migrations, roles, RLS context, CI, production database |
| [#18](https://github.com/Nocrato-Tech/ageniza/issues/18) | Encrypted daily backup to R2 with a tested restore |
| [#19](https://github.com/Nocrato-Tech/ageniza/issues/19) | Transactional email |
| [#20](https://github.com/Nocrato-Tech/ageniza/issues/20) | Better Auth in the API and web login |
| [#21](https://github.com/Nocrato-Tech/ageniza/issues/21) | Private file storage on R2 |
