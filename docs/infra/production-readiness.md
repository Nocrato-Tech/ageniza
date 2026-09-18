# Production readiness checklist

This is the single launch checklist for Ageniza. It records the manual work intentionally deferred
until a production deployment is scheduled; it does not replace the linked runbooks. Check an item
only after verifying it in the real production environment. Never put a credential, token, private
key, database URL, or completed secret value in this file or in an issue.

## 1. Release approval

- [ ] The release candidate has passed `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`,
  `pnpm db:test:local`, API and worker integration tests, `pnpm deploy:validate`,
  `pnpm test:scripts`, and ShellCheck.
- [ ] Every migration in the release is new and forward-only; no applied migration or RLS policy
  was weakened or disabled.
- [ ] The promotion PR targets `main` from `develop` and the exact merge result passed CI.
- [ ] An operator and a rollback owner are available for the launch window.

## 2. External accounts and DNS

- [ ] The production domain and Cloudflare zone are under the approved organization account.
- [ ] A dedicated Cloudflare Tunnel exists and its DNS route points to the tunnel, not to the VPS
  address. Follow the [production deploy runbook](production-deploy.md#5-cloudflare).
- [ ] The production SMTP account and sending domain are ready, with SPF, DKIM, and DMARC verified.
- [ ] The GitHub read token and GHCR pull token are least-privileged, have owners, and have recorded
  expiry/rotation dates.

## 3. Media bucket (Cloudflare R2)

This bucket stores user media. It is separate from the database-backup bucket.

- [ ] Create a private R2 bucket and an API token restricted to that bucket with only the object
  permissions required by the API and worker.
- [ ] Configure bucket CORS for the exact production application origin: allow `GET` and `PUT`,
  allow the browser's `Content-Type` request header, and expose the `ETag` response header required
  to complete multipart uploads. Add another method/header only if the production client actually
  sends it.
- [ ] Confirm or adjust R2's incomplete-multipart retention, then configure a lifecycle rule that
  expires objects under the `staging/` prefix after the approved short retention window. R2
  lifecycle filters match leading prefixes only.
- [ ] Keep canonical `original.*`, `thumbnail.jpg`, and `preview.mp4` objects out of the staging
  expiry rule.
- [ ] Fill the `R2_*`, `MEDIA_*`, and `STORAGE_QUOTA_*` values in the root-owned runtime file using
  [`infra/vps/runtime.env.example`](../../infra/vps/runtime.env.example). Do not store these
  credentials in GitHub or in the repository.
- [ ] From the real browser origin, verify a single-part image upload, a multipart video upload,
  `ETag` visibility, confirmation, signed download, thumbnail generation, and preview generation.
- [ ] Confirm that the bucket and its objects are not publicly readable.

Detailed behavior and the R2/MinIO differences are documented in the
[media module runbook](../../apps/api/src/modules/media/README.md#what-must-be-configured-by-hand-in-production-cannot-be-expressed-as-a-migration-or-compose-file).
Use Cloudflare's current [CORS](https://developers.cloudflare.com/r2/buckets/cors/) and
[object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) documentation
when applying these settings.

## 4. VPS and host-only configuration

- [ ] Provision a current Ubuntu LTS VPS and complete the [VPS baseline](vps-baseline.md), including
  the second-session SSH verification.
- [ ] Run `infra/vps/verify-vps.sh` successfully and inspect UFW manually. Only the approved SSH
  port may accept inbound traffic.
- [ ] Verify that PostgreSQL, API, web, worker, and every other application service publish no host
  port. PostgreSQL must remain reachable only on the internal Docker network.
- [ ] Install the reviewed deployment bundle with `infra/vps/install-production-deploy.sh`.
- [ ] Create `/etc/ageniza/deploy.env`, `postgres.env`, `runtime.env`, `migrations.env`, and
  `github-token` with the ownership and modes specified by the
  [production deploy runbook](production-deploy.md#4-vps).
- [ ] Replace every placeholder in the host configuration. Pin PostgreSQL and cloudflared images by
  reviewed digest.
- [ ] Set `API_TRUSTED_PROXY_CIDRS` to the actual private Docker network subnet; do not guess it.
- [ ] Install the Cloudflare Tunnel credential JSON as root-owned mode `0600` and start the tunnel.
- [ ] Verify the forced-command deploy key: `status` succeeds and an arbitrary command is refused.

## 5. Database and backup recovery

- [ ] Generate distinct owner and application-role passwords. The API and worker receive only the
  `ageniza_app` connection; the migration credential remains owner-only.
- [ ] Initialize PostgreSQL without publishing port 5432 and confirm that the application role does
  not have `BYPASSRLS`.
- [ ] Create a separate private R2 backup bucket, a bucket-scoped token, and the approved retention
  lifecycle rule.
- [ ] Store the backup encryption passphrase in the team password manager and on the VPS with mode
  `0600`.
- [ ] Enable `ageniza-backup.timer`, run one real encrypted backup, and complete
  `sudo ageniza-backup verify-restore`. Follow the [backup and restore runbook](backup-restore.md).
- [ ] Record the recovery point objective, restore owner, token rotation dates, and the date of the
  next restore rehearsal outside the repository.

Production must not receive real customer data before the backup and restore rehearsal succeeds.

## 6. GitHub production configuration

- [ ] Configure `PRODUCTION_SSH_PRIVATE_KEY` and the independently verified
  `PRODUCTION_SSH_KNOWN_HOSTS` repository secrets.
- [ ] Configure every `PRODUCTION_*` repository variable listed in the
  [production deploy runbook](production-deploy.md#1-github), including the public application URL
  and frontend API base URL.
- [ ] Confirm that no database password, Better Auth secret, SMTP credential, R2 credential, tunnel
  credential, or registry token is stored in GitHub.
- [ ] Run the production workflow's PR validation path before merging the promotion PR.

## 7. First release verification

- [ ] Observe the migration and deploy workflow through completion; record the commit SHA, workflow
  run, and deployed image digests.
- [ ] Verify `/version.txt`, `/health`, and `/api/health` through the public Cloudflare hostname.
- [ ] Confirm that the VPS address does not serve the application directly.
- [ ] Create a controlled test user and agency, complete authentication/email flows, and verify
  tenant isolation with accounts from two agencies.
- [ ] Complete the real R2 media checks from section 3 and inspect API/worker logs for redacted,
  actionable failures without signed URLs or tokens.
- [ ] Trigger and receive a real transactional email with valid DKIM.
- [ ] Confirm the daily backup timer and alert/heartbeat state after the release.
- [ ] Run `ageniza-deploy status` and confirm that the active SHA matches the public version.

## 8. Rollback readiness and handoff

- [ ] Review the automatic and manual rollback paths in the
  [production deploy runbook](production-deploy.md#rollback). Remember that schema migrations are
  never rolled back.
- [ ] Confirm who may dispatch **Production rollback** and how an incident is declared.
- [ ] Record the accepted release, remaining product limitations, manual Cloudflare changes, and
  next secret/token rotation dates in the operational change record.
- [ ] Schedule the first post-launch backup restore rehearsal and security review.
