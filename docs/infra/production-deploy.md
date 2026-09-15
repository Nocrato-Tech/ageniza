# Production deploy and rollback

This runbook operates [ADR 0010](../adr/0010-vps-edge-and-production-deployment.md) and its GitHub Free amendment. GitHub Actions builds immutable GHCR images and a release manifest. The Hostinger VPS verifies that release against GitHub itself, runs migrations, and switches web/API traffic in Caddy between `blue` and `green` Compose projects. There is no remote staging environment.

## Trust model

| Where | Holds | Can do |
| --- | --- | --- |
| GitHub repository | Secrets `PRODUCTION_SSH_PRIVATE_KEY`, `PRODUCTION_SSH_KNOWN_HOSTS`; public variables | Build and publish images; call the VPS forced command |
| VPS `ageniza-ci` account | The deploy public key with a forced command | Only `apply <sha> <run-id>`, `rollback`, `status` |
| VPS `/etc/ageniza` (root) | `runtime.env`, `migrations.env`, `github-token`, `registry/`, TLS keys | Everything production needs |

No database URL, `service_role` key, or registry credential exists in GitHub. On GitHub Free every collaborator with write access can read repository secrets from a branch workflow, so this is deliberate.

`apply` refuses a release unless, checked with the VPS's own token:

- the run is a `push` to `main` of `.github/workflows/production.yml` for that exact SHA;
- the SHA is on `main`;
- the image digests come from that run's `release-manifest` artifact and live under `ghcr.io/nocrato-tech/ageniza-*`.

**Residual risk on GitHub Free:** anyone with write access can merge a pull request into `main` (which deploys it), dispatch **Production rollback**, or push directly and edit workflows. These actions leave a record, and the [Branch guard](../ci/README.md#branch-protections-and-promotion) alerts on non-PR commits, but nothing prevents them. Grant write access only to people trusted with production.

| File | Role |
| --- | --- |
| [`.github/workflows/production.yml`](../../.github/workflows/production.yml) | PR to `main`: release-path validation. Push to `main`: origin guard, verify, publish, deploy, smoke, automatic rollback. |
| [`.github/workflows/production-rollback.yml`](../../.github/workflows/production-rollback.yml) | Manual rollback to the previous release. |
| [`.github/actions/production-ssh`](../../.github/actions/production-ssh/action.yml) | Pinned-host SSH alias `production`. |
| [`infra/vps/ageniza-deploy.sh`](../../infra/vps/ageniza-deploy.sh) | Installed as `/usr/local/sbin/ageniza-deploy`. |
| [`infra/vps/ageniza-deploy-ssh.sh`](../../infra/vps/ageniza-deploy-ssh.sh) | Forced command for the deploy key. |
| [`infra/vps/install-production-deploy.sh`](../../infra/vps/install-production-deploy.sh) | Installs the bundle, `ageniza-ci` account, sudo rule, and Cloudflare ranges. |
| [`infra/vps/refresh-cloudflare-ips.sh`](../../infra/vps/refresh-cloudflare-ips.sh) | Regenerates the Cloudflare ranges Caddy trusts for `CF-Connecting-IP`. |
| [`infra/migrations/Dockerfile`](../../infra/migrations/Dockerfile) | Migration runner image (Supabase CLI plus `supabase/migrations`). |
| [`infra/vps/*.env.example`](../../infra/vps) | Shapes of the host-only configuration files. |

## Release flow

```text
PR develop -> main: CI on the merge result + release-path validation
merge to main (a newer push replaces a pending release)
  -> release-origin: not a force push; merge commit of a develop/hotfix PR from this repository
  -> verify: lint, typecheck, test, build on the merge commit (no secrets)
  -> publish: require PRODUCTION_VITE_* variables; push api/web/worker/migrations to GHCR;
              upload release-manifest (commit, run ID, four digests)
  -> deploy: skip if main has moved on; ssh production "apply <sha> <run-id>"
       VPS: verify run, commit and manifest with GitHub -> pull digests -> snapshot runtime.env
            -> run migrations image                       # failure stops here; nothing changed
            -> start next color api/web -> recreate worker -> private health
            -> Caddy validate + reload -> write manifest
  -> smoke: https://<domain>/version.txt must equal the commit; /api/health must answer
  -> on failure, if the VPS reports this release as active: ssh production rollback
```

Traceability: images carry `APP_VERSION` and the revision label; the run summary and `release-manifest` artifact list the digests; `/var/lib/ageniza/releases/current.env` and `previous.env` record the commit, run ID, color, digests, runtime snapshot, and UTC time.

What happens when something fails:

- **Migration fails:** nothing was switched. Fix it with a new migration; never edit an applied one.
- **`apply` fails after migrations** (health, Caddy): the entrypoint restores the live release's worker and Caddy target from `current.env`, using that release's own runtime snapshot. The live color's web/API were never stopped.
- **Smoke fails, or SSH drops after activation:** the workflow asks the VPS for `status` and rolls back only if this release is the active one.
- **First release:** there is no previous release to restore or roll back to.

## One-time setup (human action required)

### 1. GitHub

Repository **secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `PRODUCTION_SSH_PRIVATE_KEY` | Private half of a new, dedicated ed25519 key (`ssh-keygen -t ed25519 -N '' -C github-actions-production -f production_deploy`) |
| `PRODUCTION_SSH_KNOWN_HOSTS` | `ssh-keyscan -p <port> <host>` output, checked against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the VPS console |

Repository **variables** (public values):

| Variable | Value |
| --- | --- |
| `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_PORT` | VPS address and SSH port |
| `PRODUCTION_SSH_USER` | `ageniza-ci` |
| `PRODUCTION_PUBLIC_URL` | `https://<domain>` (no trailing slash) |
| `PRODUCTION_VITE_API_BASE_URL` | `https://<domain>/api` |
| `PRODUCTION_VITE_SUPABASE_URL`, `PRODUCTION_VITE_SUPABASE_ANON_KEY` | Supabase project URL and **anon** key (public by design) |
| `PRODUCTION_VITE_SENTRY_DSN` | Optional |

Create two tokens for the VPS. Neither is stored in GitHub.

- **GitHub read token:** a fine-grained personal access token for `Nocrato-Tech/ageniza` only, with **Actions: Read** and **Contents: Read**. Set an expiry and a calendar reminder to rotate it.
- **GHCR pull token:** a classic token with only `read:packages`.

### 2. Supabase

Use the **Session pooler** connection string (IPv4) for both database URLs. The direct `db.<ref>.supabase.co` host is IPv6-only, and Docker's default bridge network has no IPv6. Prefer a dedicated migration role for `MIGRATION_DATABASE_URL` and a less-privileged role for runtime `DATABASE_URL` once roles exist.

### 3. VPS

After the [VPS baseline](vps-baseline.md), as root with a reviewed checkout:

```bash
sudo bash infra/vps/install-production-deploy.sh

# Non-secret settings (see infra/vps/deploy.env.example); pin Caddy by digest.
sudo install -m 0644 -o root -g root infra/vps/deploy.env.example /etc/ageniza/deploy.env
sudoedit /etc/ageniza/deploy.env

# Secrets: create with 0600 and edit in place; never copy them through the repository.
for file in runtime.env migrations.env github-token; do sudo install -m 0600 -o root -g root /dev/null /etc/ageniza/$file; done
sudoedit /etc/ageniza/runtime.env      # shape: infra/vps/runtime.env.example, no comments or APP_VERSION
sudoedit /etc/ageniza/migrations.env   # shape: infra/vps/migrations.env.example
sudoedit /etc/ageniza/github-token     # the fine-grained token only

# API_TRUSTED_PROXY_CIDRS in runtime.env is this subnet:
sudo docker network inspect ageniza-production-proxy --format '{{(index .IPAM.Config 0).Subnet}}'

# GHCR pull credential, stored only in the root registry config:
sudo docker --config /etc/ageniza/registry login ghcr.io -u <github-user> --password-stdin

# Origin TLS and Cloudflare Authenticated Origin Pulls CA:
sudo install -m 0600 -o root -g root origin.crt /etc/ageniza/caddy/tls/origin.crt
sudo install -m 0600 -o root -g root origin.key /etc/ageniza/caddy/tls/origin.key
curl -fsSLo cloudflare-origin-pull-ca.pem https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
sudo install -m 0644 -o root -g root cloudflare-origin-pull-ca.pem /etc/ageniza/caddy/tls/cloudflare-origin-pull-ca.pem

# Deploy public key, restricted to the forced command:
echo 'restrict,command="/usr/local/sbin/ageniza-deploy-ssh" ssh-ed25519 AAAA... github-actions-production' \
  | sudo tee /home/ageniza-ci/.ssh/authorized_keys >/dev/null

# Start the edge:
sudo bash -c 'set -a; . /etc/ageniza/deploy.env; set +a; docker compose -p ageniza-edge -f /opt/ageniza/compose.caddy.yml up -d'
```

Check the key restriction from your workstation: `ssh -i production_deploy ageniza-ci@<host> status` prints `RELEASE=none`, and `ssh -i production_deploy ageniza-ci@<host> id` is refused.

Optionally refresh Cloudflare ranges weekly: `echo '0 4 * * 1 root /usr/local/sbin/ageniza-refresh-cloudflare-ips' | sudo tee /etc/cron.d/ageniza-cloudflare-ips`.

Re-run the installer after changing any file in the bundle. The checkout is not needed at runtime.

### 4. Cloudflare

1. Proxy the DNS record to the VPS (orange cloud).
2. SSL/TLS mode **Full (strict)**; issue the Origin CA certificate used above.
3. Enable **Authenticated Origin Pulls** (zone-level) *before* starting Caddy with `client_auth`. Otherwise Cloudflare's requests are rejected.
4. A direct request to the origin IP must now fail the TLS handshake.

## Rollback

Automatic rollback covers a release that became active and then failed. For a later incident:

1. Run **Actions → Production rollback → Run workflow** with an incident reference.
2. The VPS re-pulls the digests in `previous.env`, recreates that color's web/API and the worker using that release's runtime snapshot, checks private health, reloads Caddy, and makes it current. The workflow then checks `/version.txt` against the active release.
3. Only one step back is kept, and a second consecutive rollback is refused. To go further back, revert on `main` and release normally.

Schema is never rolled back. Migrations must stay expand/contract compatible with the previous release. If a migration is wrong, ship a reviewed corrective migration or follow the managed Supabase restore plan. Never edit applied migrations or disable RLS.

A change to `/etc/ageniza/runtime.env` takes effect at the next release. Rollback keeps using the snapshot of the release it restores.

## Operations

```bash
sudo ageniza-deploy status
sudo cat /var/lib/ageniza/releases/current.env
sudo docker compose -p ageniza-blue ps     # or ageniza-green, ageniza-worker, ageniza-edge
sudo docker compose -p ageniza-worker logs --tail=200 worker
```

The host lock (`/run/lock/ageniza-deploy.lock`) serializes releases; do not run `docker compose up` against these projects by hand. The inactive color stays running as the rollback target. Never use `docker system prune --volumes` as recovery.

Rotate independently and record each rotation:

- **Deploy key:** replace the GitHub secret and the `authorized_keys` line.
- **VPS files:** runtime secrets, the GitHub token, the GHCR token, and TLS keys.

## Upgrading to GitHub Team

Add rulesets (see the [CI guide](../ci/README.md#branch-protections-and-promotion)) and an Environment `production` with required reviewers, restricted to `main`, on the `deploy` and rollback jobs. Keep the host-held secrets model.

## Local validation

```bash
pnpm deploy:validate   # renders production Compose + Caddy Compose with placeholder digests (needs Docker)
pnpm test:scripts      # digest-reference and merged-pull-request checks
```
