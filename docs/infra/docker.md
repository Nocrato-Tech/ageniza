# Docker operations

## Local stack

Docker Desktop (or Docker Engine with Compose v2), Node.js 22, and pnpm 9 are required. From the repository root:

```sh
pnpm docker:up
```

This starts local PostgreSQL 17 and Mailpit, applies the migrations, builds `web`, `api`, and `worker`, and waits until every healthcheck passes. Only `127.0.0.1:5173` (web), `127.0.0.1:3001` (API), `127.0.0.1:54322` (PostgreSQL, for host tools and tests), and `127.0.0.1:8025` (the Mailpit inbox) are published. Transactional email goes to Mailpit through `smtp://mailpit:1025` and never leaves the machine. The API and worker reach the database as `postgres` on the internal Compose network with the `ageniza_app` role; the worker probe stays internal, and a separate unpublished egress network gives the worker outbound access.

Inspect logs and stop the stack with:

```sh
pnpm docker:logs
pnpm docker:down
```

`docker:down` removes only the `ageniza-local` Compose containers and networks. The local database volume is kept; `pnpm db:reset` deletes it and rebuilds the schema from migrations. Production and remote resources are never addressed.

## Local database only

```sh
pnpm db:start       # PostgreSQL only
pnpm db:migrate     # apply pending migrations as the local owner
pnpm db:test:local  # integration and RLS isolation suite
pnpm db:reset       # delete the local volume, start, and migrate
```

The application role is created once, when the volume is first initialised by [`infra/postgres/initdb`](../../infra/postgres/initdb). Connect with `psql postgresql://postgres:postgres@127.0.0.1:54322/ageniza` for the owner, or with `ageniza_app:ageniza_app` to see what the application role can see.

## Direct build and production rendering

Build all application images without starting services:

```sh
docker compose build
```

Production is a base-plus-override composition. It removes local builds, local environment values, and published ports, including PostgreSQL's. Supply configuration through host-managed env files and use image references pinned by digest:

```sh
AGENIZA_API_IMAGE=registry.example/api@sha256:<64-hex-digest> \
AGENIZA_WORKER_IMAGE=registry.example/worker@sha256:<64-hex-digest> \
AGENIZA_WEB_IMAGE=registry.example/web@sha256:<64-hex-digest> \
AGENIZA_POSTGRES_IMAGE=postgres@sha256:<64-hex-digest> \
AGENIZA_RUNTIME_ENV_FILE=/etc/ageniza/runtime.env \
AGENIZA_POSTGRES_ENV_FILE=/etc/ageniza/postgres.env \
docker compose -f compose.yml -f compose.production.yml config
```

Do not use mutable tags for deployment. The env files stay outside Git; browser configuration is compiled into the web image using public build arguments only. `pnpm deploy:validate` renders this composition and the Caddy edge with placeholder digests. The reverse proxy and deployment mechanism are decided by [ADR 0010](../adr/0010-vps-edge-and-production-deployment.md) and operated through the [production deploy runbook](production-deploy.md).

## Troubleshooting

- If PostgreSQL does not start, confirm Docker is running and port `54322` is free, then inspect `docker compose logs postgres`.
- If migrations fail with `role "ageniza_app" does not exist`, the volume was created before the init script existed: run `pnpm db:reset`.
- If API or worker is unhealthy, inspect `docker compose ps` and `docker compose logs api worker`; both readiness probes require PostgreSQL.
- If web is healthy but API calls fail, confirm the browser can reach `http://127.0.0.1:3001` and that API CORS still permits `http://127.0.0.1:5173`.
- Never run a global Docker prune to recover; it can delete the local database volume and other projects' data.
