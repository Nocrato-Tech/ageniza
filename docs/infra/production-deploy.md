# Production deploy and rollback

This runbook operates the mechanism decided in [ADR 0010](../adr/0010-vps-edge-and-production-deployment.md): GitHub Actions builds immutable GHCR images, runs forward-only migrations, and deploys over pinned SSH to a fixed root-owned entrypoint on the Hostinger VPS, where Caddy switches web/API traffic between `blue` and `green` Compose projects. There is no remote staging environment.

| File | Role |
| --- | --- |
| [`.github/workflows/production.yml`](../../.github/workflows/production.yml) | PR to `main`: release-path validation. Push to `main`: publish, migrate, deploy, smoke, automatic rollback. |
| [`.github/workflows/production-rollback.yml`](../../.github/workflows/production-rollback.yml) | Manual rollback to the previous release manifest. |
| [`infra/vps/ageniza-deploy.sh`](../../infra/vps/ageniza-deploy.sh) | Installed as `/usr/local/sbin/ageniza-deploy`; `apply` and `rollback`. |
| [`infra/vps/install-production-deploy.sh`](../../infra/vps/install-production-deploy.sh) | One-time root installer for the bundle, Caddy config, and sudo rule. |
| [`infra/vps/compose.caddy.yml`](../../infra/vps/compose.caddy.yml), [`infra/vps/caddy/`](../../infra/vps/caddy) | The only public container (80/443) and its routing. |
| [`compose.production.yml`](../../compose.production.yml) | Digest-only images, runtime env file, restart/log policy, proxy network aliases. |
| [`scripts/deploy/`](../../scripts/deploy) | Digest validation, runtime env emission, Compose rendering check. |

## Release flow

```text
PR develop -> main
  -> CI (lint, typecheck, test, build, Docker, Supabase local) + release-path validation
merge to main
  -> publish: build and push api/web/worker to GHCR, record commit + digests in the run summary
  -> deploy (production Environment approval, concurrency group production-main):
       validate digests and inputs
       -> supabase db push (forward-only)      # failure stops here; app is untouched
       -> ssh ageniza-deploy apply             # runtime env + GHCR token on stdin only
            pull by digest -> start next color api/web -> recreate worker
            -> private health (API /ready, web /health, worker /ready)
            -> Caddy reload to next color -> write release manifest
       -> smoke https://<domain>/health and /api/health through Cloudflare
       -> on smoke failure: ageniza-deploy rollback
```

Traceability: each image is tagged and labelled with the commit SHA and carries `APP_VERSION`; the run summary lists the digests; the VPS keeps `/var/lib/ageniza/releases/current.env` and `previous.env` (release SHA, color, three digests, UTC time).

Failure behaviour:

- **Migration fails:** the job stops before SSH. Production keeps running the previous release. Fix with a new migration; never edit an applied one.
- **`apply` fails before activation** (pull, health, Caddy validation): the entrypoint restores the live worker image and Caddy target from `current.env`. The old color's web/API were never stopped. On the first release there is nothing to restore.
- **Smoke fails after activation:** the workflow runs `rollback`, which re-activates `previous.env`. On the first release there is no previous manifest, so the job fails and needs manual investigation.

## One-time setup (human action required)

These steps need real accounts and cannot be done from the repository.

### GitHub

1. Create the `production` Environment, restrict deployment branches to `main`, and add required reviewers. Both `publish` and `deploy` reference it, so a release asks for approval before building and before migrating.
2. Protect `main`: require the CI and `Release path validation` checks.
3. Environment **secrets**:

   | Name | Value |
   | --- | --- |
   | `PRODUCTION_DATABASE_URL` | Supabase production Postgres URL (used for migrations and runtime) |
   | `PRODUCTION_SUPABASE_URL` | `https://<project>.supabase.co` |
   | `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` | Server-only key; never a `VITE_` variable |
   | `PRODUCTION_API_CORS_ORIGINS` | Public app origin(s), comma-separated |
   | `PRODUCTION_API_TRUSTED_PROXY_CIDRS` | Subnet of the `ageniza-production-proxy` Docker network (`docker network inspect ageniza-production-proxy`) |
   | `PRODUCTION_SENTRY_DSN` | Optional |
   | `PRODUCTION_GHCR_PULL_TOKEN` | Fine-grained/classic token with `read:packages` only |
   | `PRODUCTION_SSH_PRIVATE_KEY` | Dedicated deploy key (not an administrator key) |
   | `PRODUCTION_SSH_KNOWN_HOSTS` | `ssh-keyscan -p <port> <host>` output, verified against the provider console fingerprint |
   | `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_PORT`, `PRODUCTION_SSH_USER` | VPS address, SSH port, deploy user |

4. Environment **variables** (public values): `PRODUCTION_PUBLIC_URL` (`https://<domain>`, no trailing slash), `PRODUCTION_VITE_API_BASE_URL` (`https://<domain>/api`), `PRODUCTION_VITE_SUPABASE_URL`, `PRODUCTION_VITE_SUPABASE_ANON_KEY`, `PRODUCTION_VITE_SENTRY_DSN` (optional).

### VPS

After the [VPS baseline](vps-baseline.md), as root on the host with a reviewed checkout of this repository:

```bash
sudo bash infra/vps/install-production-deploy.sh
# If DEPLOY_USER is not `ageniza`, edit /etc/sudoers.d/ageniza-deploy and re-run visudo -cf.
sudo docker network create ageniza-production-proxy
sudo install -m 0600 -o root -g root origin.crt /etc/ageniza/caddy/tls/origin.crt
sudo install -m 0600 -o root -g root origin.key /etc/ageniza/caddy/tls/origin.key
sudo tee /etc/ageniza/caddy/caddy.env >/dev/null <<'EOF'
AGENIZA_DOMAIN=app.example.com
AGENIZA_CADDY_IMAGE=caddy@sha256:<digest of the reviewed caddy:2 image>
EOF
sudo chmod 0644 /etc/ageniza/caddy/caddy.env
sudo bash -c 'set -a; . /etc/ageniza/caddy/caddy.env; docker compose -p ageniza-edge -f /opt/ageniza/compose.caddy.yml up -d'
```

Add the deploy public key to the deploy user's `authorized_keys`. The checkout can be removed after installation; the VPS never builds or pulls source. Re-run the installer after changing any file in the bundle.

### Cloudflare

Proxy the DNS record to the VPS, set SSL/TLS to **Full (strict)**, issue the Origin CA certificate used above, and restrict origin 80/443 to Cloudflare ranges (see the [VPS baseline checklist](vps-baseline.md#cloudflare-origin-checklist)).

## Rollback

Automatic rollback covers a smoke failure of the release just activated. For any later incident:

1. Run **Actions → Production rollback → Run workflow** with an incident reference. It needs the `production` Environment approval.
2. The entrypoint re-pulls the digests in `previous.env`, recreates that color's web/API and the worker, checks private health, reloads Caddy, and promotes `previous.env` to `current.env`. The workflow then smoke-tests through Cloudflare.
3. Only one step back is kept. To go further back, revert the offending commits on `main` and let a normal release deploy them.

Schema is never rolled back. Migrations must stay expand/contract compatible so the previous release still works after the newest migration. If a migration itself is wrong, ship a reviewed corrective migration or follow the managed Supabase restore plan. Never edit applied migrations or disable RLS.

Rollback reuses the runtime env installed by the most recent `apply`; a secret change that the previous release cannot run with must be reverted in the Environment and redeployed instead.

## Operations

```bash
sudo cat /var/lib/ageniza/releases/current.env
sudo docker compose -p ageniza-blue ps     # or ageniza-green, ageniza-worker, ageniza-edge
sudo docker compose -p ageniza-worker logs --tail=200 worker
```

Only the deploy lock (`/run/lock/ageniza-deploy.lock`) serialises releases on the host; do not run `docker compose up` against these projects by hand during a release. The inactive color stays running as the rollback target. Never use `docker system prune --volumes` as recovery.

## Local validation

```bash
pnpm deploy:validate   # renders production Compose + Caddy Compose with placeholder digests (needs Docker)
pnpm test:scripts      # digest-reference unit tests
```
