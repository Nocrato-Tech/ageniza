# ADR 0010: Caddy edge and controlled production deployment

- Status: Accepted; the **edge** decision is superseded by [ADR 0012](0012-cloudflare-tunnel-edge.md) (Cloudflare Tunnel instead of Caddy). The deployment mechanism below still applies.
- Date: 2026-09-15
- Deciders: Ageniza maintainers
- Issue: [#10](https://github.com/Nocrato-Tech/ageniza/issues/10)

## Context

The architecture is already fixed: GitHub Actions is the CI/CD orchestrator;
`develop` is integration only and has no remote environment; `main` represents
the one MVP remote environment, production. A Hostinger VPS runs Docker
containers for the web, API, and worker. The GitHub `production` Environment
holds production configuration and secrets; the deploy workflow runs migrations
from the approved `main` revision before it rolls out containers; and deployed
artifacts must be traceable immutable digests with health and smoke checks.

This ADR chooses only the VPS edge proxy and the final delivery mechanism. It
does not create a staging environment, alter branch policy, or perform any
external configuration or deployment.

The existing production Compose rendering documents and expects image references
by digest plus a host-managed runtime env file, but its current variables accept
any non-empty image string. Issue #14 must enforce digest-only references before
deployment uses it. The API exposes `/health` and
database-gated `/ready`; the web has `/health`; and the worker has private
loopback liveness and readiness endpoints. The worker smoke switch is rejected
in production, so a production rollout checks worker readiness rather than
enabling a test job.

## Decision

Use **Caddy** as the single public reverse-proxy container on the VPS and use
**a GitHub Actions production workflow that performs controlled SSH to the VPS
and pulls GHCR images by immutable digest**. There is no Coolify, Dokploy,
webhook receiver, VPS-side Git checkout, or VPS-side image build in the MVP.

The workflow is the sole deploy initiator. It builds and tests the web, API,
and worker images from the merged `main` commit; publishes each to GHCR; records
the returned repository digest, commit SHA, image names, and deployment time as
the release manifest; and deploys only `ghcr.io/<owner>/<image>@sha256:...`
references. Tags may aid discovery but are never deployment inputs. GitHub's
published Docker workflow documents GHCR as `ghcr.io`, supports publishing with
the workflow token, and exposes the image digest for attestation; GitHub also
recommends pinning third-party actions by commit SHA.

Caddy terminates origin TLS and is the only container with host mappings for
80 and 443. It redirects origin HTTP to HTTPS, serves a Cloudflare Origin CA
certificate (or another certificate Cloudflare validates), and reverse-proxies
only to the selected web and API candidate on private Docker networks. Caddy
does not proxy to the worker; the worker receives no public port. Configure
Cloudflare SSL/TLS as **Full (strict)**, never Flexible. Cloudflare documents
that Full (strict) validates the origin certificate and supports certificates
issued by Cloudflare Origin CA.

## Final topology

```text
Internet
  -> Cloudflare DNS/proxy and edge TLS
  -> HTTPS 443 (and HTTP 80 redirect) on Hostinger VPS
  -> Caddy (only public Docker service; origin TLS; web/API routing)
       -> web candidate (private Docker network)
       -> API candidate (private Docker network) -> managed Supabase/Postgres

  worker (private only; no Caddy route or public port) -> managed Supabase/Postgres
```

The VPS firewall permits 80/443 only from maintained Cloudflare IP ranges and
the approved SSH administration path. Direct-origin application access is
blocked or otherwise cannot serve the application. Origin certificate/key files
are mounted read-only into Caddy from a root-owned path outside the repository.
Application containers have no host `ports:` mappings; their health endpoints
are reached only from their container or the private deployment network.

## Production flow

```text
push to main
  -> GitHub Actions, protected production Environment and one deploy concurrency group
  -> build/test/push GHCR images; capture immutable digests and release manifest
  -> run main's forward-only migrations against production
  -> SSH with pinned host key -> VPS deploy command
  -> GHCR digest pull -> start private candidates -> internal health checks
  -> Caddy reload switches web/API traffic -> external smoke check through Cloudflare
  -> retain release manifest and previous digest set for rollback
```

The workflow must have a repository- and environment-scoped concurrency group
with `cancel-in-progress: false`; a VPS-side `flock` (or equivalent exclusive
lock) protects the same deployment path. A cancelled or duplicated workflow
must not overlap migrations, candidate creation, Caddy configuration reload, or
cleanup. GitHub Actions concurrency guarantees at most one running and one
pending member of a group, but ordering is not guaranteed, so the host lock and
the release manifest remain the source of operational serialization.

The SSH job verifies a pre-recorded VPS host-key fingerprint; it must not learn
a host key at deployment time. It authenticates with a dedicated production
deploy key and invokes a fixed, root-owned deploy entrypoint with narrowly
validated digest arguments rather than interpolating an arbitrary command. The
entrypoint obtains the requested images with a GHCR credential limited to
package read, writes no source checkout, and uses the production Compose
override. Docker access remains narrowly delegated through `sudo`; the deploy
account is not added to the Docker group merely for convenience.

GitHub-hosted runners have dynamic egress addresses, so the VPS must **not**
pretend that a stable GitHub runner IP allowlist protects SSH. The MVP posture
is a dedicated, non-root, key-only SSH deploy account on the configured SSH
port, with root/password login disabled, a pinned host key, no interactive
credential prompt, narrowly permitted `sudo` for the fixed entrypoint, rate
limiting/intrusion protection, and provider-console recovery. Application
ingress remains Cloudflare-only; SSH is a separately hardened administrative
service. If that public SSH exposure is unacceptable, use a private/self-hosted
runner or approved access tunnel in a later decision rather than adding a
fragile GitHub-hosted-runner IP allowlist.

Before the Caddy switch, the entrypoint must pull all three exact digests,
verify the pulled image IDs/digests against the manifest, start the worker and
web/API candidates, and wait for their Docker healthchecks. It must check API
`/ready`, web `/health`, and worker `/ready` over private paths. Only then may
it atomically reload Caddy to target the web/API candidates. After the switch,
the GitHub workflow performs a bounded HTTPS smoke check through Cloudflare
against the public application/API and records the result. A failed health or
smoke check fails the deployment and triggers the rollback procedure below.

For web/API, #14 can create two Compose **project** instances (for example,
`ageniza-blue` and `ageniza-green`) while retaining the fixed `web`, `api`, and
`worker` service names in the existing Compose files; Caddy targets the selected
project's web/API containers. This is intentionally a small blue/green switch
at the edge, not a platform or an orchestration system. The worker is not part
of Caddy blue/green routing: #14 deploys it using its fixed `worker` service,
waits for readiness, then retires the old worker under the exclusive deploy
lock. Before a durable transport is introduced, its implementation must define
how it prevents duplicate job consumption during that handoff.

## Secret and trust boundaries

| Location | Holds | Must not hold |
| --- | --- | --- |
| GitHub `production` Environment | Source of SSH private deploy key, pinned VPS host key/fingerprint, GHCR pull credential if images are private, production database/Supabase values, and public web build values | `service_role` in browser variables or workflow logs |
| GitHub runner | Secrets only for the job lifetime; immutable release manifest and non-secret digest metadata | A persistent SSH trust-on-first-use record or a checked-out production env file |
| VPS root-owned paths | Deployed copies only: `runtime.env` (mode 0600), Caddy Origin CA key/certificate, narrowly scoped registry credential/config, fixed deploy entrypoint, and retained release manifests | Git checkout, a second secret source of truth, unencrypted secret copies, or a general-purpose webhook secret receiver |
| Containers | Only the environment each runtime needs; API/worker may receive the service-role key | Any `service_role` value in web image/build arguments, browser code, or Caddy |
| Cloudflare | DNS/proxy, Full (strict) configuration, and optional least-privilege operational token | VPS SSH, GHCR, database, or application runtime secrets |

GitHub `production` Environment protection rules apply before deployment jobs
receive secrets. The job constructs `runtime.env` only in runner memory and
sends it over the pinned SSH connection on standard input to the fixed
entrypoint, which atomically installs the root-owned 0600 deployed copy; it is
not committed, placed in a workflow artifact, or echoed. The GHCR read
credential follows the same protected path to an approved root-owned Docker
credential store/config and is used only to pull manifest-listed digests.
GitHub remains the source of production secrets; the VPS retains only the
minimum deployed copies needed while containers run. Values supplied to the web
image are public build-time configuration only; the web image must never
contain a production secret. Rotate a compromised SSH key, GHCR credential,
origin key, or runtime secret independently and record the rotation in the
operational change record.

## Rollback and database compatibility

The release manifest keeps the previous successful web, API, and worker digest
set and Caddy target. For an application failure, the fixed deploy entrypoint
starts/verifies candidates from that previous set and atomically reloads Caddy
back to them; it then repeats private health checks and the public Cloudflare
smoke check. Rollback must be initiated from the GitHub production workflow,
not by manually retagging an image or running an unrecorded VPS command.

Migrations run **before** application rollout and are forward-only. Therefore,
every production migration must follow expand/contract compatibility: the
previous application version must continue to work after the migration, and
destructive schema removal waits until no rollback target needs it. An image
rollback does not roll back a migration. If a migration itself fails, stop the
rollout, preserve diagnostics, and use an explicitly reviewed corrective
migration or a managed-data restore plan; never edit migration history or
disable RLS.

## Operations, logs, and rebuild

The production workflow is the deploy audit log: retain its run URL, main SHA,
three image digests, migration result, health/smoke output (with secrets
redacted), Caddy switch result, and rollback outcome in the release manifest.
The VPS retains bounded Docker JSON-file logs (rotation configured), Caddy
access/error logs, and the fixed deploy entrypoint's structured, secret-redacted
log. Operators inspect services through the stored project/release identifier,
`docker compose ps`, and scoped `docker compose logs`; no global Docker prune
is a recovery operation.

A rebuild-from-zero VPS must be possible without recovering an application
volume: provision an Ubuntu LTS Hostinger VPS with provider-console recovery;
apply the existing VPS baseline; install Docker Engine/Compose; install the
digest-pinned Caddy edge configuration and origin certificate; configure UFW
and Cloudflare-only origin ingress; install the fixed deploy entrypoint, lock,
and root-owned secret paths; then use GitHub Actions to apply the last known
good digest manifest. Managed Supabase/Postgres data needs its separate
encrypted backup, tested restore, and retention process. Verify private
health, Caddy routing, and public Cloudflare HTTPS smoke checks before declaring
recovery complete.

## Alternatives considered

### Nginx reverse proxy

Nginx is mature and fully capable of TLS termination and HTTP proxying. It was
not selected because this MVP has one host and two public upstreams, while
Caddy provides the smaller HTTPS-plus-reverse-proxy configuration surface and
native configuration reload workflow needed for the candidate switch. Nginx
remains a valid replacement only if future routing/WAF requirements justify its
additional configuration ownership; it does not change the GitHub/SSH/digest
deployment choice.

### Traefik

Traefik integrates dynamically with Docker labels and is compelling once many
services, hosts, or routes need discovery. For this fixed three-service MVP,
that discovery/control-plane integration adds label conventions and Docker API
access beyond the edge requirements. Caddy has explicit upstreams and avoids
turning Docker discovery into routing authority.

### Coolify or Dokploy

These platforms offer a UI, webhook intake, and lifecycle management, but add a
long-running control plane, credentials, upgrades, backups, and an alternate
deployment authority on the production VPS. They would duplicate parts of
GitHub Actions while not removing the need for immutable artifact, migration,
and rollback controls. Defer them until their multi-service operational value
outweighs that cost.

### Webhook-triggered VPS deployment

A webhook receiver exposes another public trigger and secret-validation,
replay-protection, and audit surface. It also weakens the clear rule that
GitHub Actions is the deploy orchestrator. Controlled outbound SSH from the
workflow uses an already-required protected credential and produces one
auditable workflow record.

### SSH deployment that builds from Git or mutable tags

Rejected because a VPS build is not the CI-tested artifact and mutable tags do
not identify an immutable release. Registry pull by manifest-recorded digest
allows the VPS and rollback to retrieve the exact artifact previously tested.

## Consequences

This is the simplest secure MVP with a single public proxy, one authorized
deployment path, traceable artifacts, and no remote staging environment. It
requires a future implementation to add the production workflow, root-owned
deploy entrypoint, candidate Compose/Caddy configuration, release-manifest
storage, and the stated checks; none are created by this ADR. It deliberately
accepts the operational responsibility to maintain the VPS baseline, Cloudflare
origin allowlist, Caddy/origin certificates, GHCR access, and backup/restore
evidence.

## Amendment (2026-09-15): GitHub Free constraints

The organization is on GitHub Free and the repository is private, so Environment
required reviewers, deployment branch restrictions, rulesets, and branch
protection are unavailable. Any collaborator with write access can run a
workflow on any branch, so any secret stored in GitHub is readable by every
collaborator. The trust boundaries above are changed as follows, and where this
amendment conflicts with the earlier sections (blue/green candidates, Origin CA
certificates, secrets in the GitHub Environment), this amendment wins:

- **Production secrets never enter GitHub.** `runtime.env`, the migration
  database URL, the GHCR read credential, and a read-only GitHub token live
  only in root-owned files on the VPS. GitHub holds only the deploy SSH key and
  the pinned host key.
- **The deploy key can do nothing but deploy.** It belongs to a dedicated
  `ageniza-ci` account whose `authorized_keys` entry forces
  `ageniza-deploy-ssh`, which accepts only `apply <sha> <run-id>`, `rollback`,
  and `status`.
- **The VPS verifies the release itself.** For `apply`, the entrypoint uses its
  own token to confirm the run is a `push` to `main` of
  `.github/workflows/production.yml` for that SHA, that the SHA is on `main`,
  and it downloads the run's `release-manifest` artifact to learn the image
  digests. Digests are never taken from the SSH command and must belong to the
  repository's GHCR namespace.
- **Migrations run on the VPS** from an immutable `ageniza-migrations` image in
  the same manifest, before any container changes.
- **Each release keeps its `runtime.env` snapshot**, so restore and rollback do
  not inherit a later configuration edit.
- **No blue/green switch in the MVP.** A release replaces the `api`, `web`, and
  `worker` containers in place and waits for health, accepting a few seconds of
  downtime; a failed start restarts the live release. Caddy routes to the fixed
  service names. Reintroduce a candidate switch when real users need zero-downtime
  releases.
- **Caddy obtains Let's Encrypt certificates** instead of a Cloudflare Origin CA
  certificate; Cloudflare Full (strict) accepts them. Cloudflare Authenticated
  Origin Pulls is optional hardening, because Docker-published ports bypass
  source-IP firewall rules and the origin stays reachable by IP without it.

Residual risk accepted until the plan changes: anyone with write access can
still merge a pull request into `main` (which deploys it), dispatch the
rollback workflow, or push directly and edit workflows. These actions are
recorded and the Branch guard workflow alerts on non-PR commits, but they are
not prevented. After upgrading to GitHub Team, add rulesets and an Environment
with required reviewers on the deploy job; the host-held secrets model can stay.

## References

- [GitHub: publishing Docker images, including GHCR and digest attestations](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub: workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Docker: image digests](https://docs.docker.com/dhi/explore/security-concepts/digests/)
- [Cloudflare: Full (strict) encryption mode](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [Cloudflare: Origin CA certificates](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Caddy: `reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Nginx: HTTP proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Traefik Proxy documentation](https://doc.traefik.io/traefik/)
