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
```

Turbo runs the matching command in each workspace. Workspace packages are linked with explicit `workspace:*` dependencies as they are introduced.

## Branches and environments

Feature, fix, and refactor branches target `develop`. `main` is production only; there is no remote staging environment in the MVP. Production configuration belongs in GitHub's `production` Environment, never in Git or a Docker image.

See [the CI guide](docs/ci/README.md) for the pull-request gates, local-equivalent commands, migration policy, branch protections, and hotfix reconciliation procedure.
