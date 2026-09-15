# Ageniza

Agency Operations Platform by Nocrato Tech.

## Prerequisites

- Node.js 22.14+ (see `.nvmrc`)
- pnpm 9.15+
- Docker and the Supabase CLI for local database-backed development

## Quick start

```sh
pnpm install
pnpm dev
```

Start the local stack with `pnpm db:start` and apply the canonical migration history with `pnpm db:reset` before running database-backed modules. `pnpm db:test:local` runs the local integration/RLS suite. Local development must never point at production resources.

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
pnpm db:reset
pnpm db:test:local
pnpm docker:up
pnpm docker:down
pnpm docker:logs
```

## Docker local stack

`pnpm docker:up` starts pinned local Supabase, builds the application images, and waits for health. It exposes only web (`127.0.0.1:5173`) and API (`127.0.0.1:3001`); worker probes stay internal. `pnpm docker:down` removes only this Compose project and its scoped local Supabase stack.

Containers use explicit `APP_CONTAINER_LOCAL=true` plus Docker's exact `host.docker.internal` gateway mapping to reach host-local Supabase. Production applies `compose.production.yml` with immutable images and a server runtime env file; it intentionally includes no source build, secrets, proxy, or deploy-tool choice. See the [Docker guide](docs/infra/docker.md) for build, production rendering, cleanup, and troubleshooting.

Turbo runs the matching command in each workspace. Workspace packages are linked with explicit `workspace:*` dependencies as they are introduced.

## Branches and environments

Feature, fix, and refactor branches target `develop`. `main` is production only; there is no remote staging environment in the MVP. Production configuration belongs in GitHub's `production` Environment, never in Git or a Docker image.

See [the CI guide](docs/ci/README.md) for the pull-request gates, local-equivalent commands, migration policy, branch protections, and hotfix reconciliation procedure.
