# Dev environment on the VPS

The dev environment runs on the same Hostinger VPS as production will, is published automatically on every merge to `develop`, and is capped so it can never take CPU or memory from production ([ADR 0013](../adr/0013-dev-environment-on-the-vps.md); the product decision is `docs/business/decisions/2026-10-29-estrutural-ambiente-de-dev-na-vps.md`). It reuses the mechanism of the [production deploy](production-deploy.md) and the edge of [ADR 0012](../adr/0012-cloudflare-tunnel-edge.md), as a second independent copy.

- App and API: `https://dev.ageniza.com.br` (the web container serves the SPA and proxies `/api`).
- Every e-mail the product sends: the Mailpit inbox at `https://mail-dev.ageniza.com.br`, behind Cloudflare Access (the owner's e-mail only). Nothing is delivered to a real address.
- Payments: `PAYMENTS_PROVIDER=simulado` (the deploy requires the variable). The API and the worker run with `APP_ENV=production` here, so what tells this environment from the real production is `DEPLOY_TARGET=dev`, which only `compose.dev.yml` sets: the simulated provider runs only with it (`runsAsProduction` in `@ageniza/config`), and the production deploy refuses both keys in its `runtime.env`. The dev image is built with the simulated code; the production release is built without it (`PAYMENTS_SIMULATED=exclude`, removed in the build stage of [`apps/api/Dockerfile`](../../apps/api/Dockerfile) and [`apps/worker/Dockerfile`](../../apps/worker/Dockerfile)). The worker renews the subscriptions there; `PAYMENTS_SIMULATED_RENEWAL=declined` in the dev `runtime.env` (optional, `approved` or `declined`) makes every renewal fail, to exercise the three days of grace.

Nothing here needs the repository on the VPS at runtime, and no secret lives in the repository or in GitHub except the dev SSH key.

## What runs, and what it may use

| Container | vCPU | Memory | PIDs |
| --- | --- | --- | --- |
| `postgres` | 0.25 | 768 MiB | 200 |
| `api` | 0.20 | 512 MiB | 256 |
| `worker` (ffmpeg for video previews) | 0.25 | 768 MiB | 512 |
| `web` (nginx) | 0.05 | 64 MiB | 64 |
| `mailpit` | 0.05 | 128 MiB | 64 |
| `cloudflared` | 0.05 | 128 MiB | 64 |
| migration job (only while a release applies) | 0.15 | 384 MiB | 128 |
| **Total** | **1.00** | **2.69 GiB** | |

The values live in [`infra/vps/dev-limits.env`](../../infra/vps/dev-limits.env) and nowhere else; `compose.dev.yml`, the tunnel Compose file and the deploy entrypoint all read that file. Each memory limit equals its swap limit, so a runaway container is killed, not paged. To change a limit, edit that file in a pull request: `pnpm deploy:validate` fails when the sum goes past 1 vCPU or 3 GiB, and re-running `install-dev-deploy.sh` on the VPS installs it. The Docker daemon's own work during a release (pulling and unpacking images) is outside these limits; it lasts seconds.

No container publishes a port. The only inbound port of the VPS stays SSH. PostgreSQL is on the internal network `ageniza-dev_dev-private` and is never published.

## Release flow

```text
merge to develop
  -> Dev release / publish: build api, worker, web, migrations; tag ghcr.io/nocrato-tech/ageniza-<name>:develop-<sha>;
                            upload dev-release-manifest (TARGET=dev, commit, run ID, four digests)
  -> Dev release / deploy:  skip if develop moved on; ssh dev "apply-dev <sha> <run-id>"
       VPS: verify the run (push to develop of dev.yml for that SHA), that the SHA is on develop, and the manifest
            -> pull the digests -> check runtime.env -> snapshot it -> postgres healthy -> run the migrations image
            -> replace mailpit/api/web/worker -> private health -> write the release
  -> smoke: https://dev.ageniza.com.br/version.txt equals the commit; /api/health answers
```

If the new containers do not become healthy, the VPS restarts the release that was live. Dev has no manual rollback: fix forward, or re-run the workflow of an older commit. Tags are for people; the VPS only ever deploys the digests from the manifest it downloads from GitHub itself.

`dev.yml` does not repeat lint and tests: the pull request passed them on the merge result and CI runs again on the push to `develop`. A broken `develop` reaches dev, and the smoke test says so.

## What the owner needs to do

The domain and the Cloudflare account do not exist yet. Nothing below can be done by the repository; everything the repository needs is ready for when they exist.

### 1. Register the domain (Registro.br)

1. At [registro.br](https://registro.br), register `ageniza.com.br` under the company's CNPJ (or the owner's CPF). Keep the registrant e-mail one that the owner will always read.
2. Leave the DNS at Registro.br for now; it is changed in step 3, after the Cloudflare zone exists.

### 2. Create the Cloudflare account and the zone

1. Create a Cloudflare account with the e-mail of the company, turn on two-factor authentication, and keep recovery codes offline.
2. **Add a site** → `ageniza.com.br` → the Free plan. Cloudflare shows two name servers.
3. Leave the DNS records Cloudflare scans as they are (there is nothing to preserve).
4. Under **SSL/TLS**, set the mode to **Full (strict)**. TLS ends at Cloudflare, and Flexible is never used.

### 3. Point the domain at Cloudflare (Registro.br)

1. If DNSSEC is enabled at Registro.br, turn it off first.
2. In Registro.br, change the DNS servers of `ageniza.com.br` to the two Cloudflare name servers and wait until Cloudflare shows the zone as active.
3. Optionally, enable DNSSEC in Cloudflare and copy its DS record into Registro.br.

### 4. Zero Trust and the Access application for the inbox

1. In Cloudflare, open **Zero Trust**, choose the Free plan and create a team name (for example `ageniza`). Write it down: it is `AGENIZA_ACCESS_TEAM_NAME` below, and the team domain is `<team>.cloudflareaccess.com`.
2. **Access → Applications → Add an application → Self-hosted**: name `Ageniza dev inbox`, domain `mail-dev.ageniza.com.br`, session duration 24 hours.
3. Add one **Allow** policy whose only rule is **Emails** = the owner's e-mail address. Enable only the **One-time PIN** login method. Do not add "Everyone", a domain rule, or a Bypass policy.
4. Save, open the application and copy its **Application Audience (AUD) Tag**: 64 hexadecimal characters. It is `AGENIZA_ACCESS_AUD_TAG` below.

`cloudflared` also refuses any request to the inbox hostname that does not carry a valid Access token for that application, so a mistake in the policy does not expose the inbox: it locks everyone out until the policy is fixed.

### 5. Create the dev tunnel (from a workstation with `cloudflared`)

```bash
cloudflared tunnel login                       # authorises the zone in a browser
cloudflared tunnel create ageniza-dev          # prints the tunnel UUID and a credentials JSON path
cloudflared tunnel route dns ageniza-dev dev.ageniza.com.br
cloudflared tunnel route dns ageniza-dev mail-dev.ageniza.com.br
```

This is a tunnel of its own: never reuse the production one. The UUID is `AGENIZA_TUNNEL_ID` below. Routing is in Git ([`infra/vps/cloudflared/dev-config.yml`](../../infra/vps/cloudflared/dev-config.yml)); nothing about routing is configured in the dashboard. The credentials JSON is a secret: it only ever goes to the VPS.

### 6. Cloudflare R2 for dev

Create two private buckets whose names contain `dev` (for example `ageniza-media-dev` and `ageniza-identity-dev`) and one API token per bucket, each scoped to its own bucket alone. The deploy refuses bucket names without `dev`, so a production bucket cannot be wired by mistake. Configure each bucket's CORS for the origin `https://dev.ageniza.com.br` as described for production in the [readiness checklist](production-readiness.md#3-media-bucket-cloudflare-r2) and the [media module runbook](../../apps/api/src/modules/media/README.md#what-must-be-configured-by-hand-in-production-cannot-be-expressed-as-a-migration-or-compose-file).

### 7. GitHub

In **Settings → Environments**, create the environment `dev` and restrict its **deployment branches** to `develop` only. Do this **before** you add `DEV_SSH_PRIVATE_KEY`: a secret of an environment without the branch restriction can be read by a workflow that runs from any branch, so the key must never exist while the restriction is missing. The repository is public today, which is what makes environments available on the Free plan; if it turns private again on that plan, environments stop working and the same names go to repository secrets and variables, with `environment: dev` removed from `dev.yml`.

Environment **secrets**:

| Secret | Value |
| --- | --- |
| `DEV_SSH_PRIVATE_KEY` | Private half of a new ed25519 key made only for dev: `ssh-keygen -t ed25519 -N '' -C github-actions-dev -f dev_deploy` |
| `DEV_SSH_KNOWN_HOSTS` | `ssh-keyscan -p <port> <host>` output, checked against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the VPS console |

Environment **variables** (public values):

| Variable | Value |
| --- | --- |
| `DEV_SSH_HOST`, `DEV_SSH_PORT` | VPS address and SSH port |
| `DEV_SSH_USER` | `ageniza-dev-ci` (the action refuses anything else) |
| `DEV_PUBLIC_URL` | `https://dev.ageniza.com.br` |
| `DEV_VITE_API_BASE_URL` | `https://dev.ageniza.com.br/api` |
| `DEV_VITE_SENTRY_DSN` | Optional |

Never copy a `PRODUCTION_*` value, the production key, or a production token into this environment.

The workflow is off until the owner turns it on: it publishes and deploys only when the **repository** variable `DEV_DEPLOY_ENABLED` is `true` (Settings → Secrets and variables → Actions → Variables; a repository variable, because a job reads the switch before it enters the environment). Leave it unset until the VPS is ready and the first deploy is wanted; remove it to stop dev deploys.

Create two tokens for the VPS. Neither is stored in GitHub.

- **GitHub read token:** a fine-grained personal access token for `Nocrato-Tech/ageniza` only, with **Actions: Read** and **Contents: Read**, an expiry and a calendar reminder. A new token of its own keeps its rotation independent from production.
- **GHCR pull token:** a classic token with only `read:packages`.

## One-time setup on the VPS (as root, after the [VPS baseline](vps-baseline.md))

```bash
sudo bash infra/vps/install-dev-deploy.sh

# Non-secret settings: shape in infra/vps/dev-deploy.env.example. Pin PostgreSQL, Mailpit and cloudflared by digest.
sudo install -m 0644 -o root -g root infra/vps/dev-deploy.env.example /etc/ageniza-dev/dev-deploy.env
sudoedit /etc/ageniza-dev/dev-deploy.env

# Secrets: create with 0600 and edit in place; never copy them through the repository.
for file in postgres.env runtime.env migrations.env github-token; do sudo install -m 0600 -o root -g root /dev/null /etc/ageniza-dev/$file; done
sudoedit /etc/ageniza-dev/postgres.env     # shape: infra/vps/dev-postgres.env.example
sudoedit /etc/ageniza-dev/runtime.env      # shape: infra/vps/dev-runtime.env.example, no comments
sudoedit /etc/ageniza-dev/migrations.env   # shape: infra/vps/dev-migrations.env.example
sudoedit /etc/ageniza-dev/github-token     # the fine-grained token only

# GHCR pull credential, stored only in the dev registry config:
sudo docker --config /etc/ageniza-dev/registry login ghcr.io -u <github-user> --password-stdin

# Deploy public key of the dev environment, restricted to the dev forced command:
echo 'restrict,command="/usr/local/sbin/ageniza-deploy-dev-ssh" ssh-ed25519 AAAA... github-actions-dev' \
  | sudo tee /home/ageniza-dev-ci/.ssh/authorized_keys >/dev/null

# The dev tunnel credentials, then re-run the installer so it renders the tunnel config with the Access values.
# The cloudflared container runs as gid 65532, so the group reads the file and no one else does (mode 0600 would
# keep the tunnel from starting: "open /etc/cloudflared/config.yml: permission denied"):
sudo install -m 0640 -o root -g 65532 credentials.json /etc/ageniza-dev/cloudflared/credentials.json
sudo bash infra/vps/install-dev-deploy.sh
sudo bash -c 'set -a; . /etc/ageniza-dev/dev-deploy.env; set +a; docker compose -p ageniza-dev-edge --env-file /opt/ageniza-dev/dev-limits.env -f /opt/ageniza-dev/compose.dev-tunnel.yml up -d'
```

The installer refuses to install the tunnel config until `AGENIZA_ACCESS_TEAM_NAME` and `AGENIZA_ACCESS_AUD_TAG` are the real values, so the tunnel cannot start with a placeholder.

Check the key restriction from a workstation: `ssh -i dev_deploy ageniza-dev-ci@<host> status-dev` prints `RELEASE=none`, while `ssh -i dev_deploy ageniza-dev-ci@<host> id` and `ssh -i dev_deploy ageniza-dev-ci@<host> status` are refused. The production key must be refused on `status-dev` too.

The first deploy needs no command: it happens on the next merge to `develop`, or by re-running the jobs of the latest **Dev release** run in GitHub Actions.

### Files and variables on the server

| File | Contents (no values here) |
| --- | --- |
| `/etc/ageniza-dev/dev-deploy.env` | `AGENIZA_REPOSITORY`, `AGENIZA_IMAGE_NAMESPACE`, `AGENIZA_POSTGRES_IMAGE`, `AGENIZA_MAILPIT_IMAGE`, `AGENIZA_TUNNEL_IMAGE` (all pinned by digest), `AGENIZA_TUNNEL_ID`, `AGENIZA_ACCESS_TEAM_NAME`, `AGENIZA_ACCESS_AUD_TAG` |
| `/etc/ageniza-dev/postgres.env` | `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `AGENIZA_APP_DB_PASSWORD` (generate both passwords fresh; never a production one) |
| `/etc/ageniza-dev/migrations.env` | `MIGRATION_DATABASE_URL` |
| `/etc/ageniza-dev/runtime.env` | `APP_ENV=production`, `BETTER_AUTH_SECRET` (fresh), `APP_PUBLIC_URL`, `API_CORS_ORIGINS`, `AUTH_TERMS_VERSION`, `AUTH_PRIVACY_VERSION`, `DATABASE_URL`, `PAYMENTS_PROVIDER=simulado`, `WORKER_SMOKE_JOB=false`, the `R2_*` and `IDENTITY_STORAGE_*` settings of the dev buckets, and the optional ones listed in the example |
| `/etc/ageniza-dev/github-token`, `registry/`, `cloudflared/credentials.json` | the GitHub read token, the GHCR login, the dev tunnel credentials |

`SMTP_URL`, `EMAIL_FROM`, `DEPLOY_TARGET` and `API_TRUSTED_PROXY_CIDRS` must not be in `runtime.env`: `compose.dev.yml` fixes them, and `ageniza-deploy-dev` refuses a file that names them. The entrypoint also refuses a `runtime.env` whose `APP_PUBLIC_URL` is not `https://dev.ageniza.com.br`, whose payments provider is not the simulated one, or whose R2 buckets do not have `dev` in the name.

## Operations

```bash
sudo ageniza-deploy-dev status-dev
sudo cat /var/lib/ageniza-dev/releases/current.env
sudo docker ps --filter label=com.docker.compose.project=ageniza-dev
sudo docker stats --no-stream $(sudo docker ps -q --filter label=com.docker.compose.project=ageniza-dev)
sudo docker logs --tail=200 ageniza-dev-worker-1
```

Do not run `docker compose up` against `ageniza-dev` by hand; the host lock (`/run/lock/ageniza-deploy-dev.lock`) serializes releases. The dev data is disposable and not backed up (decision `2026-10-29-dev-na-vps-sem-backup-e-sem-dado-real`): to start from an empty database, remove the containers of the project and its volume (`sudo docker rm -f $(sudo docker ps -aq --filter label=com.docker.compose.project=ageniza-dev)`, then `sudo docker volume rm ageniza-dev_postgres-data`; the project label and the volume name keep this away from production) and re-run the latest **Dev release** deploy. Never run `docker system prune --volumes` on this host.

Rotate independently of production: the dev SSH key (the GitHub secret and the `authorized_keys` line), the GitHub read token, the GHCR token, and the dev tunnel credentials.

## Checks before trusting it

- `ss -tlnp` on the VPS lists `sshd` and nothing from Docker; `ufw status` allows only SSH.
- `https://mail-dev.ageniza.com.br` asks for a one-time PIN and, for any other e-mail, never shows the inbox.
- Trigger a password reset on `https://dev.ageniza.com.br`: the message appears in the inbox and arrives nowhere else.
- `docker inspect` of the dev containers shows their CPU, memory and PID limits.
