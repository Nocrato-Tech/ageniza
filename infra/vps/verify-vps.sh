#!/usr/bin/env bash
# Read-only verification companion for bootstrap-ubuntu.sh.
set -Eeuo pipefail
IFS=$'\n\t'

DEPLOY_USER="ageniza"
SSH_PORT="22"
FAILURES=0

usage() { printf 'Usage: sudo %s [--user USER] [--ssh-port PORT]\n' "${0##*/}"; }
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

while (($#)); do
  case "$1" in
    --user) DEPLOY_USER="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { printf 'Run as root so SSH and UFW checks are complete.\n' >&2; exit 2; }
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { printf 'Invalid --user.\n' >&2; exit 2; }
[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || { printf 'Invalid --ssh-port.\n' >&2; exit 2; }

[[ -r /etc/os-release ]] && grep -qx 'ID=ubuntu' /etc/os-release && pass 'Ubuntu detected' || fail 'Ubuntu was not detected'
id "$DEPLOY_USER" >/dev/null 2>&1 && pass "deploy user exists: $DEPLOY_USER" || fail "deploy user missing: $DEPLOY_USER"
[[ -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]] && pass 'deploy public key installed' || fail 'deploy public key missing'

for service in docker.service containerd.service systemd-timesyncd.service unattended-upgrades.service; do
  systemctl is-enabled --quiet "$service" && pass "$service enabled" || fail "$service not enabled"
  systemctl is-active --quiet "$service" && pass "$service active" || fail "$service not active"
done

command -v docker >/dev/null && docker compose version >/dev/null && pass 'Docker Engine and Compose plugin available' || fail 'Docker Engine or Compose plugin unavailable'
[[ "$(timedatectl show --property=Timezone --value 2>/dev/null)" == UTC ]] && pass 'timezone is UTC' || fail 'timezone is not UTC'
[[ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" == yes ]] && pass 'NTP synchronized' || warn 'NTP has not synchronized yet'

sshd -T 2>/dev/null | grep -qx "port $SSH_PORT" && pass "effective SSH port is $SSH_PORT" || fail "effective SSH port is not $SSH_PORT"
sshd -T 2>/dev/null | grep -qx 'permitrootlogin no' && pass 'root SSH login disabled' || fail 'root SSH login is not disabled'
sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' && pass 'SSH password login disabled' || fail 'SSH password login is not disabled'

ufw status | grep -q 'Status: active' && pass 'UFW active' || fail 'UFW inactive'
for port in "$SSH_PORT" 80 443; do
  ufw status | grep -Eq "^${port}/tcp[[:space:]]+ALLOW" && pass "UFW allows TCP $port" || fail "UFW does not allow TCP $port"
done

PUBLISHED_HOST_PORTS="$(docker ps --format '{{.Ports}}' | grep -Eo '(0\.0\.0\.0|\[::\]):[0-9]+' || true)"
UNAPPROVED_HOST_PORTS="$(printf '%s\n' "$PUBLISHED_HOST_PORTS" | grep -Ev ':(80|443)$' || true)"
if [[ -n "$UNAPPROVED_HOST_PORTS" ]]; then
  fail "Docker publishes unapproved all-interface host ports: $(printf '%s' "$UNAPPROVED_HOST_PORTS" | tr '\n' ' ')"
elif [[ -n "$PUBLISHED_HOST_PORTS" ]]; then
  pass 'only approved proxy ports 80/443 are published on all interfaces'
else
  pass 'no Docker container currently publishes all-interface ports'
fi

if ((FAILURES)); then
  printf '\nVerification failed with %s issue(s). Do not close the existing administrative SSH session.\n' "$FAILURES" >&2
  exit 1
fi
printf '\nBaseline verification passed. Manually confirm a second key-based SSH login before ending the original session.\n'
