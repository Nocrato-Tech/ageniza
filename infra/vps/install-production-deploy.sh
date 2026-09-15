#!/usr/bin/env bash
# Root installer for the reviewed deployment bundle. Run on the VPS from a reviewed checkout; safe to re-run.
set -Eeuo pipefail
IFS=$'\n\t'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Run as root.'
SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPOSITORY_ROOT="$(cd "$SOURCE_DIR/../.." && pwd)"
readonly APP_ROOT=/opt/ageniza
readonly CI_USER=ageniza-ci

for file in \
  "$SOURCE_DIR/ageniza-deploy.sh" "$SOURCE_DIR/ageniza-deploy-ssh.sh" "$SOURCE_DIR/ageniza-deploy.sudoers" \
  "$SOURCE_DIR/refresh-cloudflare-ips.sh" "$SOURCE_DIR/compose.caddy.yml" "$SOURCE_DIR/caddy/Caddyfile" \
  "$SOURCE_DIR/caddy/active-upstream.caddy.example" "$REPOSITORY_ROOT/compose.yml" "$REPOSITORY_ROOT/compose.production.yml"; do
  [[ -f "$file" && ! -L "$file" ]] || die "Missing required bundle file: $file"
done
# Validate before installing: a broken file in /etc/sudoers.d disables sudo host-wide.
visudo -cf "$SOURCE_DIR/ageniza-deploy.sudoers" >/dev/null || die 'sudoers rule is invalid; nothing was installed'
command -v docker >/dev/null || die 'Docker is not installed; run bootstrap-ubuntu.sh first'

DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl jq unzip >/dev/null

# Dedicated account for the GitHub Actions key: no sudo group, no Docker group, forced command only.
if ! id "$CI_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' --shell /bin/bash "$CI_USER"
fi
install -d -o "$CI_USER" -g "$CI_USER" -m 0700 "/home/$CI_USER/.ssh"
[[ -f "/home/$CI_USER/.ssh/authorized_keys" ]] || install -o "$CI_USER" -g "$CI_USER" -m 0600 /dev/null "/home/$CI_USER/.ssh/authorized_keys"

install -d -o root -g root -m 0750 "$APP_ROOT" /etc/ageniza /etc/ageniza/caddy /etc/ageniza/caddy/tls
install -d -o root -g root -m 0700 /etc/ageniza/registry /var/lib/ageniza/releases
install -o root -g root -m 0755 "$SOURCE_DIR/ageniza-deploy.sh" /usr/local/sbin/ageniza-deploy
install -o root -g root -m 0755 "$SOURCE_DIR/ageniza-deploy-ssh.sh" /usr/local/sbin/ageniza-deploy-ssh
install -o root -g root -m 0755 "$SOURCE_DIR/refresh-cloudflare-ips.sh" /usr/local/sbin/ageniza-refresh-cloudflare-ips
install -o root -g root -m 0644 "$REPOSITORY_ROOT/compose.yml" "$APP_ROOT/compose.yml"
install -o root -g root -m 0644 "$REPOSITORY_ROOT/compose.production.yml" "$APP_ROOT/compose.production.yml"
install -o root -g root -m 0644 "$SOURCE_DIR/compose.caddy.yml" "$APP_ROOT/compose.caddy.yml"
install -o root -g root -m 0644 "$SOURCE_DIR/caddy/Caddyfile" /etc/ageniza/caddy/Caddyfile
[[ -f /etc/ageniza/caddy/active-upstream.caddy ]] || install -o root -g root -m 0644 "$SOURCE_DIR/caddy/active-upstream.caddy.example" /etc/ageniza/caddy/active-upstream.caddy
install -o root -g root -m 0440 "$SOURCE_DIR/ageniza-deploy.sudoers" /etc/sudoers.d/ageniza-deploy
docker network inspect ageniza-production-proxy >/dev/null 2>&1 || docker network create ageniza-production-proxy >/dev/null
/usr/local/sbin/ageniza-refresh-cloudflare-ips || printf 'WARNING: could not refresh Cloudflare ranges; run ageniza-refresh-cloudflare-ips before starting Caddy.\n' >&2

cat <<EOF
Installed the deployment bundle. Finish the host setup from docs/infra/production-deploy.md:
  - /etc/ageniza/deploy.env, runtime.env, migrations.env, and github-token
  - GHCR login into /etc/ageniza/registry
  - Origin CA certificate/key and the Cloudflare origin-pull CA in /etc/ageniza/caddy/tls
  - the GitHub Actions public key in /home/$CI_USER/.ssh/authorized_keys with the forced command
  - start Caddy
EOF
