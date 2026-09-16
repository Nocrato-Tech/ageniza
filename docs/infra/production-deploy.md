# Production deploy and rollback

This runbook operates [ADR 0010](../adr/0010-vps-edge-and-production-deployment.md) and its GitHub Free amendment. GitHub Actions builds immutable GHCR images and a release manifest. The Hostinger VPS verifies that release against GitHub itself, runs migrations, and replaces the `api`, `web`, and `worker` containers in place behind a Cloudflare Tunnel ([ADR 0012](../adr/0012-cloudflare-tunnel-edge.md)). A release causes a few seconds of downtime, which is accepted for the MVP. There is no remote staging environment.

## Trust model

| Where | Holds | Can do |
| --- | --- | --- |
| GitHub repository | Secrets `PRODUCTION_SSH_PRIVATE_KEY`, `PRODUCTION_SSH_KNOWN_HOSTS`; public variables | Build and publish images; call the VPS forced command |
| VPS `ageniza-ci` account | The deploy public key with a forced command | Only `apply <sha> <run-id>`, `rollback`, `status` |
| VPS `/etc/ageniza` (root) | `postgres.env`, `runtime.env`, `migrations.env`, `github-token`, `registry/` | Everything production needs |

No database password, auth secret, or registry credential exists in GitHub. On GitHub Free every collaborator with write access can read repository secrets from a branch workflow, so this is deliberate.

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
| [`infra/vps/compose.tunnel.yml`](../../infra/vps/compose.tunnel.yml), [`infra/vps/cloudflared/config.yml`](../../infra/vps/cloudflared/config.yml) | The outbound tunnel and its versioned ingress rules; no port is published. |
| [`infra/migrations/Dockerfile`](../../infra/migrations/Dockerfile) | Migration runner image (Knex plus `packages/database/migrations`). |
| [`infra/postgres/initdb`](../../infra/postgres/initdb) | Creates the `ageniza_app` role when the database volume is first initialised. |
| [`infra/vps/ageniza-backup.sh`](../../infra/vps/ageniza-backup.sh) | Daily encrypted dump to R2 and the restore rehearsal ([runbook](backup-restore.md)). |
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
            -> ensure postgres is healthy -> run migrations image   # failure stops here; nothing changed
            -> replace api/web/worker in place -> private health -> write manifest
  -> smoke: https://<domain>/version.txt must equal the commit; /api/health must answer
  -> on failure, if the VPS reports this release as active: ssh production rollback
```

Traceability: images carry `APP_VERSION` and the revision label; the run summary and `release-manifest` artifact list the digests; `/var/lib/ageniza/releases/current.env` and `previous.env` record the commit, run ID, digests, runtime snapshot, and UTC time.

What happens when something fails:

- **Migration fails:** nothing was switched. Fix it with a new migration; never edit an applied one.
- **The new containers fail to become healthy:** the entrypoint restarts the live release from `current.env` with that release's own runtime snapshot. Expect downtime until it is healthy again.
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
| `PRODUCTION_VITE_SUPABASE_URL`, `PRODUCTION_VITE_SUPABASE_ANON_KEY` | Temporary: any non-empty placeholder until issue #20 removes the Supabase web client |
| `PRODUCTION_VITE_SENTRY_DSN` | Optional |

Create two tokens for the VPS. Neither is stored in GitHub.

- **GitHub read token:** a fine-grained personal access token for `Nocrato-Tech/ageniza` only, with **Actions: Read** and **Contents: Read**. Set an expiry and a calendar reminder to rotate it.
- **GHCR pull token:** a classic token with only `read:packages`.

### 2. PostgreSQL

PostgreSQL 17 runs on the VPS as the internal `postgres` container ([ADR 0011](../adr/0011-self-hosted-postgres-and-better-auth.md)); its port is never published. Generate two long alphanumeric passwords (for example `openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40`) so they need no URL escaping:

| File | Contents |
| --- | --- |
| `/etc/ageniza/postgres.env` | `POSTGRES_USER=postgres`, `POSTGRES_DB=ageniza`, `POSTGRES_PASSWORD=<owner password>`, `AGENIZA_APP_DB_PASSWORD=<application password>` |
| `/etc/ageniza/migrations.env` | `MIGRATION_DATABASE_URL=postgresql://postgres:<owner password>@postgres:5432/ageniza` |
| `/etc/ageniza/runtime.env` | `DATABASE_URL=postgresql://ageniza_app:<application password>@postgres:5432/ageniza` |

- The `ageniza_app` role is created only when the data volume is first initialised. Changing `AGENIZA_APP_DB_PASSWORD` later does nothing; rotate with `ALTER ROLE ageniza_app PASSWORD '...'` and update `runtime.env`.
- Pin `AGENIZA_POSTGRES_IMAGE` by digest in `deploy.env`. A new digest of the same major version restarts the database briefly at the next release. A major-version change needs a dump and restore, never an in-place image swap.
- **Backups are not optional:** set up the [backup and restore runbook](backup-restore.md) (encrypted daily dumps to R2, with a rehearsed restore) before production holds real data.

### 3. Transactional email

Invitations, email verification, and password resets need SMTP before the authentication work (issue #20) ships. Any provider with SMTP works; the application has no provider SDK.

1. Create the account and a sending domain (for example a subdomain such as `mail.<domain>`), then add its **SPF, DKIM, and DMARC** records. Without them, invitations land in spam or are rejected.
2. Create a sending credential scoped to that domain.
3. Add both keys to `/etc/ageniza/runtime.env` — the application refuses to start with only one of them:

   ```
   SMTP_URL=smtps://<user>:<key>@<smtp host>:465
   EMAIL_FROM=Ageniza <no-reply@mail.example.com>
   ```

4. Send one real message to yourself before the first invitation goes out, and confirm it arrives with a passing DKIM signature.

### 4. VPS

After the [VPS baseline](vps-baseline.md), as root with a reviewed checkout:

```bash
sudo bash infra/vps/install-production-deploy.sh

# Non-secret settings (see infra/vps/deploy.env.example); pin PostgreSQL and cloudflared by digest.
sudo install -m 0644 -o root -g root infra/vps/deploy.env.example /etc/ageniza/deploy.env
sudoedit /etc/ageniza/deploy.env

# Secrets: create with 0600 and edit in place; never copy them through the repository.
for file in postgres.env runtime.env migrations.env github-token; do sudo install -m 0600 -o root -g root /dev/null /etc/ageniza/$file; done
sudoedit /etc/ageniza/postgres.env     # shape: infra/vps/postgres.env.example
sudoedit /etc/ageniza/runtime.env      # shape: infra/vps/runtime.env.example, no comments or APP_VERSION
sudoedit /etc/ageniza/migrations.env   # shape: infra/vps/migrations.env.example
sudoedit /etc/ageniza/github-token     # the fine-grained token only

# API_TRUSTED_PROXY_CIDRS in runtime.env is this subnet:
sudo docker network inspect ageniza-production-proxy --format '{{(index .IPAM.Config 0).Subnet}}'

# GHCR pull credential, stored only in the root registry config:
sudo docker --config /etc/ageniza/registry login ghcr.io -u <github-user> --password-stdin

# Deploy public key, restricted to the forced command:
echo 'restrict,command="/usr/local/sbin/ageniza-deploy-ssh" ssh-ed25519 AAAA... github-actions-production' \
  | sudo tee /home/ageniza-ci/.ssh/authorized_keys >/dev/null

# Start the edge (outbound only; nothing listens on the public interface):
sudo bash -c 'set -a; . /etc/ageniza/deploy.env; set +a; docker compose -p ageniza-edge -f /opt/ageniza/compose.tunnel.yml up -d'
```

Check the key restriction from your workstation: `ssh -i production_deploy ageniza-ci@<host> status` prints `RELEASE=none`, and `ssh -i production_deploy ageniza-ci@<host> id` is refused.

Re-run the installer after changing any file in the bundle. The checkout is not needed at runtime.

### 5. Cloudflare

The tunnel is created once, from a workstation with `cloudflared` installed. Routing itself is versioned in [`infra/vps/cloudflared/config.yml`](../../infra/vps/cloudflared/config.yml), so nothing about request routing is configured in the dashboard ([ADR 0012](../adr/0012-cloudflare-tunnel-edge.md)).

```bash
cloudflared tunnel login                       # authorises the zone in a browser
cloudflared tunnel create ageniza-production   # prints the tunnel UUID and a credentials JSON path
cloudflared tunnel route dns ageniza-production app.example.com
```

1. Put the UUID in `/etc/ageniza/deploy.env` as `AGENIZA_TUNNEL_ID`, and pin `AGENIZA_TUNNEL_IMAGE` to a reviewed `cloudflare/cloudflared` digest.
2. Copy the credentials JSON to the VPS as `/etc/ageniza/cloudflared/credentials.json`, owned by root with mode 0600. It is a secret: it authorises running this tunnel.
3. Start the tunnel with the command in the VPS section above, then confirm `https://<domain>/health` and `https://<domain>/api/health` answer.
4. Check the origin is not reachable directly: the VPS has no inbound port open except SSH, and no DNS record points to its IP.

**TLS ends at Cloudflare**, so there is no origin certificate to install or renew. Leave SSL/TLS in the default **Full** or **Full (strict)** mode; Flexible is never used.

Optional: put **Cloudflare Access** in front of any internal hostname you add later (an admin tool, for example) by adding an ingress rule with a `hostname` match and an Access policy. It costs nothing on the free plan and keeps those tools off the public internet.

## Rollback

Automatic rollback covers a release that became active and then failed. For a later incident:

1. Run **Actions → Production rollback → Run workflow** with an incident reference.
2. The VPS re-pulls the digests in `previous.env`, replaces the containers using that release's runtime snapshot, checks private health, and makes it current. The workflow then checks `/version.txt` against the active release.
3. Only one step back is kept, and a second consecutive rollback is refused. To go further back, revert on `main` and release normally.

Schema is never rolled back. Migrations must stay expand/contract compatible with the previous release. If a migration is wrong, ship a reviewed corrective migration or follow the managed Supabase restore plan. Never edit applied migrations or disable RLS.

A change to `/etc/ageniza/runtime.env` takes effect at the next release. Rollback keeps using the snapshot of the release it restores.

## Operations

```bash
sudo ageniza-deploy status
sudo cat /var/lib/ageniza/releases/current.env
sudo docker compose -p ageniza ps          # application and postgres; ageniza-edge for the tunnel
sudo docker compose -p ageniza exec postgres psql -U postgres ageniza
sudo docker compose -p ageniza logs --tail=200 worker
```

The host lock (`/run/lock/ageniza-deploy.lock`) serializes releases; do not run `docker compose up` against these projects by hand. Never use `docker system prune --volumes` as recovery; the `postgres-data` volume holds the database.

Rotate independently and record each rotation:

- **Deploy key:** replace the GitHub secret and the `authorized_keys` line.
- **VPS files:** database passwords (with `ALTER ROLE`), the GitHub token, and the GHCR token.

## Upgrading to GitHub Team

Add rulesets (see the [CI guide](../ci/README.md#branch-protections-and-promotion)) and an Environment `production` with required reviewers, restricted to `main`, on the `deploy` and rollback jobs. Keep the host-held secrets model.

## Local validation

```bash
pnpm deploy:validate   # renders production Compose + tunnel Compose with placeholder digests (needs Docker)
pnpm test:scripts      # digest-reference and merged-pull-request checks
```
