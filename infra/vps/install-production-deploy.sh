#!/usr/bin/env bash
# One-time root installer for the reviewed deployment bundle. Run on the VPS only.
set -Eeuo pipefail
IFS=$'\n\t'

[[ $EUID -eq 0 ]] || { printf 'Run as root.\n' >&2; exit 1; }
SOURCE_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
APP_ROOT=/opt/ageniza

for file in "$SOURCE_DIR/ageniza-deploy.sh" "$SOURCE_DIR/compose.caddy.yml" "$SOURCE_DIR/caddy/Caddyfile" "$SOURCE_DIR/../../compose.yml" "$SOURCE_DIR/../../compose.production.yml" "$SOURCE_DIR/ageniza-deploy.sudoers"; do
  [[ -f "$file" && ! -L "$file" ]] || { printf 'Missing required bundle file: %s\n' "$file" >&2; exit 1; }
done
install -d -o root -g root -m 0750 "$APP_ROOT" /etc/ageniza /etc/ageniza/caddy /etc/ageniza/caddy/tls /var/lib/ageniza/releases /etc/ageniza/registry
install -o root -g root -m 0755 "$SOURCE_DIR/ageniza-deploy.sh" /usr/local/sbin/ageniza-deploy
install -o root -g root -m 0644 "$SOURCE_DIR/../../compose.yml" "$APP_ROOT/compose.yml"
install -o root -g root -m 0644 "$SOURCE_DIR/../../compose.production.yml" "$APP_ROOT/compose.production.yml"
install -o root -g root -m 0644 "$SOURCE_DIR/compose.caddy.yml" "$APP_ROOT/compose.caddy.yml"
install -o root -g root -m 0644 "$SOURCE_DIR/caddy/Caddyfile" /etc/ageniza/caddy/Caddyfile
[[ -f /etc/ageniza/caddy/active-upstream.caddy ]] || install -o root -g root -m 0644 "$SOURCE_DIR/caddy/active-upstream.caddy.example" /etc/ageniza/caddy/active-upstream.caddy
install -o root -g root -m 0440 "$SOURCE_DIR/ageniza-deploy.sudoers" /etc/sudoers.d/ageniza-deploy
visudo -cf /etc/sudoers.d/ageniza-deploy
printf 'Installed root-owned deployment bundle. Add /etc/ageniza/caddy/caddy.env and Origin CA files, then start Caddy as root.\n'
