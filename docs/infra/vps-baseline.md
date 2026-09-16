# Ubuntu VPS baseline

This is the reproducible host baseline for a clean Ubuntu LTS Hostinger VPS. It is intentionally host-only: it does not access Hostinger, Cloudflare, DNS, GitHub, a live SSH host, or any production resource. It does not install the edge or the deployment entrypoint; after this baseline, follow the [production deploy runbook](production-deploy.md) (ADR 0010 for the deploy mechanism, ADR 0012 for the Cloudflare Tunnel edge). References below to "ADR #10" and "the future proxy" mean that runbook.

## Preconditions

- Provision a current Ubuntu LTS host with console/recovery access available in the provider panel.
- Generate a dedicated administrator **public** key locally. Keep the private key in the team's approved secret storage, never in this repository or the VPS config file.
- Copy [`bootstrap.env.example`](../../infra/vps/bootstrap.env.example) to a protected path on the host, replace the placeholder key, and set the intended non-root deploy user and SSH port.
- Start from a root console/session and leave it open until the separate-login check below passes. The bootstrap creates a key-only deploy account and subsequently disables root and password SSH login.

The config is Bash assignments, not a secret store. It must be owner-readable only:

```bash
sudo install -m 0600 -o root -g root /tmp/bootstrap.env /root/ageniza-bootstrap.env
sudo bash ./infra/vps/bootstrap-ubuntu.sh --config /root/ageniza-bootstrap.env
```

The deploy account is in the `sudo` group but is created with its password locked. While the original root session is still open, set and test a distinct administrator sudo password (`sudo passwd <DEPLOY_USER>`); SSH itself remains public-key-only. Do not configure blanket passwordless sudo or add the account to the Docker group unless an approved deployment design explicitly requires it.

The bootstrap is safe to re-run for the same desired state. It validates `sshd` before reload, opens the desired SSH port before changing SSH, and preserves existing UFW rules by default. That preservation is deliberate: automatic UFW reset can lock out a host with an unknown network path.

## Safe SSH and firewall staging

The script enables UFW and permits **only** TCP SSH: the Cloudflare Tunnel connects outbound, so nothing inbound is needed ([ADR 0012](../adr/0012-cloudflare-tunnel-edge.md)). On a fresh VPS, set `LOCKDOWN_UFW=true` to reset UFW to precisely that one ingress rule. A host bootstrapped before this decision still allows 80 and 443: remove them with `sudo ufw delete allow 80/tcp` and `sudo ufw delete allow 443/tcp`. On any host that may have prior rules, leave it false, complete the second-login check, inspect `sudo ufw status numbered`, then remove each unapproved inbound rule deliberately.

Immediately after bootstrap, from a second terminal—not the original root session—run:

```bash
ssh -p <SSH_PORT> <DEPLOY_USER>@<SERVER_IP>
sudo bash ./infra/vps/verify-vps.sh --user <DEPLOY_USER> --ssh-port <SSH_PORT>
sudo ufw status numbered
```

If key login fails, keep the original session open. The SSH drop-in is `/etc/ssh/sshd_config.d/90-ageniza.conf`; correct or remove it, run `sudo sshd -t`, and only then run `sudo systemctl reload ssh`. The bootstrap retains a prior drop-in at `/etc/ssh/sshd_config.d/90-ageniza.conf.pre-ageniza` when one existed. Provider console access remains the last-resort recovery path.

## Host policy

- Docker Engine and the Compose plugin come from Docker's official signed Ubuntu APT repository. The deploy user is not added to the Docker group by default because that group is root-equivalent; use narrowly approved sudo access until ADR #10 defines deployment automation.
- The host uses UTC, `systemd-timesyncd`, and unattended security updates. Automatic reboot is off: reboots remain a scheduled, verified operation.
- The deploy user is key-only. Keep the SSH port and public key in the protected bootstrap config; do not put passwords, private keys, Cloudflare tokens, or application secrets in any script, image, compose file, or Git checkout.
- **No service publishes a port.** The Cloudflare Tunnel connects outbound ([ADR 0012](../adr/0012-cloudflare-tunnel-edge.md)), so every application, worker, cache, queue, and database service stays on an internal Docker network with no `ports:` mapping. Use `expose:` only when service-to-service documentation benefits from it. Remember that Docker-published ports bypass UFW, which is exactly why none exist.
- Every non-job container needs a healthcheck and `restart: unless-stopped` (or a more intentional approved policy). Image tags must be immutable/digested for releases; logs need bounded rotation; deploys must wait for healthy services before traffic changes.
- PostgreSQL runs on this VPS only as the internal `postgres` container ([ADR 0011](../adr/0011-self-hosted-postgres-and-better-auth.md)), never with a published port. Its volume must never be the only copy of critical data: encrypted off-host backups with retention and a tested restore ([backup and restore runbook](backup-restore.md)) are required before production holds real data.

Example Compose policy fragment (not a deployment stack):

```yaml
services:
  api:
    restart: unless-stopped
    networks: [private]
    # No ports: mapping: the Cloudflare Tunnel is the only public entry point (ADR 0012).
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
networks:
  private:
    internal: true
```

## Normal operations and recovery

Before maintenance, confirm a backup/restore path for every stateful dependency, use a second SSH session, and check container health:

```bash
sudo bash ./infra/vps/verify-vps.sh --user <DEPLOY_USER> --ssh-port <SSH_PORT>
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo apt-get update
apt list --upgradable
```

For routine OS updates, schedule a maintenance window, apply `sudo apt-get upgrade`, run the verification script, and reboot only when required (`test -f /var/run/reboot-required`). Before rebooting, record the running release/image digests and ensure the Compose project uses restart policies. After `sudo systemctl reboot`, reconnect with the second-key procedure and verify Docker services and application health checks.

For an application rebuild, use the future ADR #10 deployment mechanism. Build/retrieve a tested immutable image, start it with a healthcheck, verify it internally, then switch traffic through the future proxy. Never use `docker system prune --volumes` as recovery and never rebuild a critical system from an unverified local Docker volume. A host-loss recovery is: provision a new Ubuntu LTS host, run this baseline, configure the approved proxy/deployment integration, restore managed data from a tested backup, deploy the last known-good immutable release, then verify health and public routing.

## Cloudflare origin checklist

Complete this manually in the approved Cloudflare account after ADR #10 defines the proxy/origin topology; this runbook makes no API calls.

- The public hostname is a DNS record created by `cloudflared tunnel route dns`; it points at the tunnel, not at the VPS IP. There is no A record for the application.
- TLS ends at Cloudflare. There is no origin certificate to install or renew, and no origin IP allowlist to maintain.
- Confirm the origin serves nothing directly: the application answers only through the tunnel hostname, and the VPS has no inbound port open except SSH.
- Keep Cloudflare API tokens least-privileged, environment-scoped, and in approved secret storage only. Record DNS, TLS, proxy, cache, WAF, and origin-rule changes in the operational change record.

## Verification limits

The included verifier confirms the host prerequisites, effective SSH configuration, UFW rules, Docker/Compose availability, time sync, updates service, and accidental all-interface Docker port mappings. It cannot prove a remote key login, Hostinger console recovery, DNS propagation, Cloudflare proxy/TLS/origin protection, image health endpoints, backups, or a restore: those require an approved environment and are intentionally out of scope for this local-only task.
