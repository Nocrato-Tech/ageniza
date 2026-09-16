# Docker operations

## Local stack

Docker Desktop (or Docker Engine with Compose v2), Node.js 22, and pnpm 9 are required. From the repository root:

```sh
pnpm docker:up
```

This starts the pinned Supabase CLI stack, reads its disposable local anon/service keys at runtime, builds `web`, `api`, and `worker`, and waits until every application healthcheck passes. The keys are never written to the repository or image metadata beyond the public anon key compiled into the local web build. Only `127.0.0.1:5173` (web) and `127.0.0.1:3001` (API) are published. The worker probe and service-to-service traffic remain on Compose networks; a separate, unpublished egress network lets the worker reach Supabase without joining the web-facing network.

Inspect logs and stop the scoped stacks with:

```sh
pnpm docker:logs
pnpm docker:down
```

`docker:down` removes only the `ageniza-local` Compose project and the repository's local Supabase stack. Supabase is stopped with `--no-backup`, so its disposable local database is removed; production and cloud resources are never addressed.

## Direct build and production rendering

Build all application images without starting services:

```sh
docker compose build
```

Production is a base-plus-override composition. It removes local builds, local environment values, host-gateway aliases, and published development ports. Supply server configuration through a host-managed env file and use registry references pinned by digest:

```sh
AGENIZA_API_IMAGE=registry.example/api@sha256:<64-hex-digest> \
AGENIZA_WORKER_IMAGE=registry.example/worker@sha256:<64-hex-digest> \
AGENIZA_WEB_IMAGE=registry.example/web@sha256:<64-hex-digest> \
AGENIZA_RUNTIME_ENV_FILE=/srv/ageniza/runtime.env \
docker compose -f compose.yml -f compose.production.yml config
```

Do not use mutable tags for deployment. The env file must stay outside Git and must provide production runtime values; browser configuration is compiled into the web image using public build arguments only. `pnpm deploy:validate` renders this composition and the Caddy edge with placeholder digests. The reverse proxy and deployment mechanism are decided by [ADR 0010](../adr/0010-vps-edge-and-production-deployment.md) and operated through the [production deploy runbook](production-deploy.md).

## Troubleshooting

- If Supabase does not start, confirm Docker is running and ports `54321` and `54322` are free, then run `pnpm docker:down` before retrying.
- If API or worker is unhealthy, inspect `docker compose ps` and `docker compose logs api worker`; both readiness probes require the local PostgreSQL endpoint.
- If Linux containers cannot resolve the host service, verify Compose v2 supports `host-gateway`. Do not replace the exact `host.docker.internal` alias with an arbitrary remote hostname.
- If web is healthy but API calls fail, confirm the browser can reach `http://127.0.0.1:3001` and that API CORS still permits `http://127.0.0.1:5173`.
- Cleanup is failure-tolerant: the script attempts both Compose and Supabase teardown even when one command fails. It never runs a global Docker prune.
