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

When database-backed modules are added, start the local stack with `supabase start` before running the affected app. Local development must never point at production resources.

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
```

Turbo runs the matching command in each workspace. Workspace packages are linked with explicit `workspace:*` dependencies as they are introduced.

## Branches and environments

Feature, fix, and refactor branches target `develop`. `main` is production only; there is no remote staging environment in the MVP. Production configuration belongs in GitHub's `production` Environment, never in Git or a Docker image.
