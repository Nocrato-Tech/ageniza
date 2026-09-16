# Ageniza

Agency Operations Platform by Nocrato Tech.

## Prerequisites

- Node.js 22.14+ (see `.nvmrc`)
- pnpm 9.15+
- Docker with Compose v2 for the local PostgreSQL database and container stack

## Quick start

```sh
pnpm install
pnpm dev
```

Copy `.env.example` to `.env`, start local PostgreSQL with `pnpm db:start`, and apply migrations with `pnpm db:migrate` before running database-backed modules. `pnpm db:test:local` runs the integration and RLS isolation suite, and `pnpm db:reset` rebuilds the local database from migrations. Local development must never point at production resources.

## Workspace layout

```text
apps/
  web/       React product SPA
  api/       Fastify modular monolith
  worker/    Node background process
packages/
  core/      shared infrastructure primitives
  config/    validated runtime configuration
  contracts/ public HTTP contracts
  database/  Knex, migrations, and database infrastructure
  ui/        shared UI primitives
```

Business modules belong in `apps/api/src/modules`; they do not become packages by default. The architecture intentionally has no generic `packages/shared` catch-all.

## Commands

```sh
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm db:start
pnpm db:migrate
pnpm db:reset
pnpm db:test:local
pnpm docker:up
pnpm docker:down
pnpm docker:logs
```

## Docker local stack

`pnpm docker:up` starts local PostgreSQL, applies migrations, builds the application images, and waits for health. It exposes only web (`127.0.0.1:5173`), API (`127.0.0.1:3001`), PostgreSQL (`127.0.0.1:54322`), and the Mailpit inbox (`127.0.0.1:8025`), all on loopback; worker probes stay internal. `pnpm docker:down` removes this Compose project's containers and keeps the local database volume.

Containers use explicit `APP_CONTAINER_LOCAL=true` to reach the `postgres` Compose service. Production applies `compose.production.yml` with immutable images and a server runtime env file; it includes no source build or secrets. See the [Docker guide](docs/infra/docker.md) for build, production rendering, cleanup, and troubleshooting, and the [production deploy runbook](docs/infra/production-deploy.md) for the GitHub Actions release, host-side verification, and rollback.

Turbo runs the matching command in each workspace. Workspace packages are linked with explicit `workspace:*` dependencies as they are introduced.

## Branches and environments

Feature, fix, and refactor branches target `develop`. `main` is production only; there is no remote staging environment in the MVP. Production configuration belongs in GitHub's `production` Environment, never in Git or a Docker image.

See [the CI guide](docs/ci/README.md) for the pull-request gates, local-equivalent commands, migration policy, branch protections, and hotfix reconciliation procedure.
