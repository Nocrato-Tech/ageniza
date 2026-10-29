# ADR 0013: A dev environment on the production VPS, published from `develop`

- Status: Accepted
- Date: 2026-10-29
- Deciders: Ageniza maintainers; the product owner decided the scope on 2026-10-29 (decision `2026-10-29-estrutural-ambiente-de-dev-na-vps`)
- Issue: [#774](https://github.com/Nocrato-Tech/ageniza/issues/774)
- Amends: [ADR 0010](0010-vps-edge-and-production-deployment.md), which said `develop` has no remote environment. The deploy mechanism of ADR 0010 and the edge of [ADR 0012](0012-cloudflare-tunnel-edge.md) are reused, not replaced.

## Context

Only the owner's machine runs the product today. The Hostinger KVM 2 (2 vCPU, 8 GB, 100 GB) is bootstrapped (#765) and idle until the first pilot agency. The owner decided that the dev environment goes up first, on that VPS, published automatically on every merge to `develop`; production joins the same VPS at the first pilot and moves to its own VPS once customers pay. The dev environment must therefore never take CPU or memory from production, never reach its data or credentials, and never send mail to a real person.

## Decision

The dev environment is a second, independent copy of the production model, not a mode of it.

| | Production | Dev |
| --- | --- | --- |
| Compose project and files | `ageniza`, `compose.yml` + `compose.production.yml` | `ageniza-dev`, `compose.yml` + `compose.dev.yml` |
| Networks and volumes | `ageniza_production-private`, `ageniza-production-proxy`, `ageniza_postgres-data` | `ageniza-dev_dev-private` (fixed subnet `172.30.250.0/24`), `ageniza-dev-proxy`, `ageniza-dev_postgres-data` |
| Entrypoint, lock, releases | `ageniza-deploy`, `/run/lock/ageniza-deploy.lock`, `/var/lib/ageniza` | `ageniza-deploy-dev`, `/run/lock/ageniza-deploy-dev.lock`, `/var/lib/ageniza-dev` |
| Host configuration | `/etc/ageniza`, `/opt/ageniza` | `/etc/ageniza-dev`, `/opt/ageniza-dev` |
| SSH account and key | `ageniza-ci`, `PRODUCTION_SSH_*` | `ageniza-dev-ci`, `DEV_SSH_*` |
| Forced command | `apply`, `rollback`, `status` | `apply-dev`, `status-dev` |
| Release source | push to `main` of `production.yml`, artifact `release-manifest` | push to `develop` of `dev.yml`, artifact `dev-release-manifest` |
| Images | `ghcr.io/nocrato-tech/ageniza-*:<sha>`, deployed by digest | the same repositories, tag `develop-<sha>`, deployed by digest |
| Tunnel | `ageniza-edge`, one hostname | `ageniza-dev-edge`, its own tunnel and credentials, two hostnames |

**Isolation.** Neither key can run the other environment: the forced command of each key names only its own entrypoint, and each entrypoint has its own sudo rule for its own account. The dev entrypoint verifies that the run is a push to `develop` of `dev.yml` for a commit that is on `develop`, and refuses a manifest whose `TARGET` is not `dev`; the production entrypoint is untouched.

**Resources.** `infra/vps/dev-limits.env` is the only place that sizes dev. Every container has `cpus`, `mem_limit`, `memswap_limit` (equal to `mem_limit`, so no swap) and `pids_limit`; the one-shot migration job runs under the same kind of limits. Together they stay at or under 1 vCPU and 3 GiB, and `scripts/deploy/dev-model.mjs` fails the pull request that goes past it. The pull-and-unpack work of the Docker daemon during a release is outside those limits and is accepted: it lasts seconds, and a release only runs after a merge.

**Mail.** The dev environment sends mail to the Mailpit container and nowhere else, enforced three times so that one mistake is not enough: `compose.dev.yml` fixes `SMTP_URL` and `EMAIL_FROM` above the host's `runtime.env`, the deploy entrypoint refuses a `runtime.env` that names them, and the API and the worker refuse to start with `DEPLOY_TARGET=dev` and any `SMTP_URL` other than `smtp://mailpit:1025`. The inbox is exposed at `mail-dev.ageniza.com.br` behind Cloudflare Access (the owner's e-mail only); `cloudflared` also requires a valid Access token for that hostname, so a missing or wrong Access policy fails closed.

**Data.** Dev has its own database, its own Cloudflare R2 buckets and tokens, its own `BETTER_AUTH_SECRET`, and `PAYMENTS_PROVIDER=simulado`. The entrypoint refuses buckets without `dev` in the name. Dev is not backed up and never receives real data (decision `2026-10-29-dev-na-vps-sem-backup-e-sem-dado-real`).

**Secrets.** The GitHub environment `dev`, restricted to the `develop` branch, holds only the dev SSH key and public variables. Database passwords, auth secrets, R2 tokens and the registry credential live on the VPS, as for production.

## Consequences

- Every merge to `develop` is deployed after CI, and `dev.yml` does not repeat lint and tests: the pull request already passed them on the merge result, and CI runs again on the push. A broken `develop` therefore reaches dev, which is the point of having it; the smoke test reports it, and the VPS restores the release that was live when the new one fails to start.
- One VPS now has two Compose projects, two tunnels and two deploy accounts. Changing the shared base `compose.yml` affects both; `pnpm deploy:validate` renders both models on every pull request.
- A failed `apply-dev` that happens after the migrations leaves the dev schema ahead of the restored release, as it does for production; migrations stay expand/contract compatible.
- Moving production to its own VPS later removes the shared-host constraints; the dev environment keeps its limits or relaxes them by editing `dev-limits.env`.

## Alternatives considered

### The same project with a `dev` profile

Fewer files, but one `docker compose` command or one `.env` mistake would put dev on the production database or network. Rejected: the point is that dev cannot reach production.

### A shared deploy key and entrypoint with an environment argument

One program to maintain, but the dev key could then name production. Rejected for the same reason; the cost is a copy of the entrypoint that the review and the tests cover.

### A second VPS for dev

Cleaner isolation, but the owner chose to use the VPS that will host production until there are paying customers.

### Letting dev send real mail to a test inbox

Simpler to exercise deliverability, but any test address, copied production row or typo would send mail to a person. Mailpit has no such failure.
