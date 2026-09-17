# @ageniza/config

Validated runtime configuration for Ageniza. It deliberately has two import paths:

- `@ageniza/config/server` is for Node runtimes only (the API and worker). It validates `APP_ENV`, `PORT`, and `DATABASE_URL` (the `ageniza_app` role, never the migration owner). The API loader additionally provides `API_HOST`, `API_CORS_ORIGINS`, `API_BODY_LIMIT_BYTES`, and `API_TRUSTED_PROXY_CIDRS` for HTTP bootstrap. The worker loader owns its loopback probe host/port and explicitly local/CI-only smoke switch.
- `@ageniza/config/browser` is for Vite browser code only. It accepts and returns only public values such as `VITE_API_BASE_URL`; the temporary `VITE_SUPABASE_*` values are removed with the Supabase web client in issue #20.

Never import the server entrypoint from `apps/web`; the browser loader is intentionally narrow so server values cannot be copied into frontend configuration or bundled code. `DATABASE_URL` and every other credential are server-only, including in local development.

## Runtimes

The supported runtime model is `local` (with `development` accepted as an alias), `test`/`ci`, and `production`. `staging` is rejected and is not a deployment target; `develop` is a Git branch, not a runtime. In `local` and `test`, API and database URLs must point to a loopback host (or, with `APP_CONTAINER_LOCAL=true`, the local Compose `postgres` service), which prevents developer machines and CI from accidentally using production resources. Production rejects loopback resources and requires HTTPS for browser and API URLs. Validation failures never include supplied values.

API and worker loaders read `APP_ENV`; the Vite loader derives the equivalent runtime from Vite's `MODE`. Copy the root `.env.example` to `.env`; its database URLs match the local Compose PostgreSQL.

`API_CORS_ORIGINS` is a comma-separated allowlist of complete browser origins; wildcard origins are never used. `API_TRUSTED_PROXY_CIDRS` is empty by default, so `X-Forwarded-*` headers are ignored until the actual reverse-proxy network is named explicitly. Keep the body limit small globally and give upload routes their own deliberate, bounded override.

`WORKER_HEALTH_HOST` accepts only `127.0.0.1` or `::1`; the probe port must remain private to the worker container. `WORKER_SMOKE_JOB=true` is a deterministic local/CI bootstrap mode and is rejected in production. `WORKER_CONCURRENCY` (default `1`, at most `4`) is how many durable queue jobs the worker runs at once; it stays low because the worker shares the VPS with PostgreSQL and the API.

## Production secrets

Production values live only in root-owned env files on the VPS ([production deploy runbook](../../docs/infra/production-deploy.md)), never in GitHub, a commit, or an image. The application consumes ordinary environment variables, so a future vendor-neutral secret-injection mechanism (for example a platform secret store, workload identity, or an external secret manager) only needs to provide the same names before process startup. Browser variables remain public by design; do not place any credential in a `VITE_` variable.
