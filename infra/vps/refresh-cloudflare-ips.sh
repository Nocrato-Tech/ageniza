#!/usr/bin/env bash
# Regenerates the Cloudflare ranges Caddy trusts for CF-Connecting-IP. Run as root; safe to schedule weekly.
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

readonly OUTPUT=/etc/ageniza/caddy/cloudflare-trusted-proxies.caddy
readonly DEPLOY_CONFIG=/etc/ageniza/deploy.env
readonly CADDY_COMPOSE=/opt/ageniza/compose.caddy.yml

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Run as root.'

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
ranges=()
for list in ips-v4 ips-v6; do
  curl --fail --silent --show-error --proto '=https' --max-time 30 --output "$work/$list" "https://www.cloudflare.com/$list" || die "cannot download Cloudflare $list"
  while IFS= read -r range || [[ -n "$range" ]]; do
    [[ -n "$range" ]] || continue
    [[ "$range" =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ ]] || die "unexpected Cloudflare range: $range"
    ranges+=("$range")
  done < "$work/$list"
done
(( ${#ranges[@]} >= 10 )) || die 'Cloudflare returned too few ranges; keeping the existing file'

{ printf 'trusted_proxies static'; printf ' %s' "${ranges[@]}"; printf '\n'; } > "$work/trusted.caddy"
install -o root -g root -m 0644 "$work/trusted.caddy" "$OUTPUT"
printf 'Wrote %s Cloudflare ranges to %s\n' "${#ranges[@]}" "$OUTPUT"

# Reload a running edge so the new ranges apply immediately.
if [[ -f "$DEPLOY_CONFIG" && -f "$CADDY_COMPOSE" ]]; then
  value() { awk -F= -v key="$1" '$1 == key { print substr($0, length(key) + 2); exit }' "$DEPLOY_CONFIG"; }
  AGENIZA_DOMAIN="$(value AGENIZA_DOMAIN)"
  AGENIZA_CADDY_IMAGE="$(value AGENIZA_CADDY_IMAGE)"
  export AGENIZA_DOMAIN AGENIZA_CADDY_IMAGE
  if [[ -n "$(docker compose -p ageniza-edge -f "$CADDY_COMPOSE" ps -q caddy 2>/dev/null)" ]]; then
    docker compose -p ageniza-edge -f "$CADDY_COMPOSE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    printf 'Reloaded Caddy.\n'
  fi
fi
