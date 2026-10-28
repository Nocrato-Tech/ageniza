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

# Ubuntu 25.10 and newer ship chrony as the time daemon; older releases use systemd-timesyncd.
time_service() {
  if systemctl cat chrony.service >/dev/null 2>&1; then
    printf 'chrony.service\n'
  else
    printf 'systemd-timesyncd.service\n'
  fi
}

for service in docker.service containerd.service "$(time_service)" unattended-upgrades.service; do
  systemctl is-enabled --quiet "$service" && pass "$service enabled" || fail "$service not enabled"
  systemctl is-active --quiet "$service" && pass "$service active" || fail "$service not active"
done

command -v docker >/dev/null && docker compose version >/dev/null && pass 'Docker Engine and Compose plugin available' || fail 'Docker Engine or Compose plugin unavailable'
[[ "$(timedatectl show --property=Timezone --value 2>/dev/null)" == UTC ]] && pass 'timezone is UTC' || fail 'timezone is not UTC'
[[ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" == yes ]] && pass 'NTP synchronized' || warn 'NTP has not synchronized yet'

# sshd -T is read once into a variable: with pipefail, `sshd -T | grep -q` dies of SIGPIPE when grep exits at the first match
# and the 4 KiB of output is still being written, so the check would fail even on a correct configuration.
# Plain 'sshd -T' ignores Match blocks, so the settings are read for the global scope, for root and for the deploy user.
check_effective_ssh() {
  local target scope effective ports setting
  local -a args
  for target in "" root "$DEPLOY_USER"; do
    args=(-T)
    scope=""
    if [[ -n "$target" ]]; then
      args+=(-C "user=$target,host=localhost,addr=127.0.0.1")
      scope=" for user $target"
    fi
    effective="$(sshd "${args[@]}" 2>/dev/null || true)"
    for setting in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no'; do
      if grep -qxF -- "$setting" <<<"$effective"; then
        pass "effective SSH $setting$scope"
      else
        fail "effective SSH setting is not '$setting'$scope"
      fi
    done
    if [[ -z "$target" ]]; then
      ports="$(grep '^port ' <<<"$effective" || true)"
      if [[ "$ports" == "port $SSH_PORT" ]]; then
        pass "effective SSH port is $SSH_PORT"
      else
        fail "effective SSH port is not only $SSH_PORT"
      fi
    fi
  done
}

# TCP ports where sshd listens, one per line: sshd's own sockets and, when it is active, the ones of ssh.socket.
listening_ssh_ports() {
  {
    ss -Htlnp 2>/dev/null | awk '/users:\(\("sshd"/ { n = split($4, parts, ":"); print parts[n] }' || true
    if systemctl is-active --quiet ssh.socket; then
      systemctl show ssh.socket --property=Listen --value | awk 'NF { n = split($1, parts, ":"); print parts[n] }'
    fi
  } | sort -un
}

check_listening_ssh() {
  local listening
  listening="$(listening_ssh_ports | paste -sd, -)"
  if [[ "$listening" == "$SSH_PORT" ]]; then
    pass "sshd listens only on TCP $SSH_PORT"
  else
    fail "sshd listens on '${listening:-nothing}', expected only $SSH_PORT"
  fi
}

check_effective_ssh
check_listening_ssh

ufw status | grep -q 'Status: active' && pass 'UFW active' || fail 'UFW inactive'
if ufw status | grep -Eq "^${SSH_PORT}/tcp[[:space:]]+ALLOW"; then
  pass "UFW allows TCP $SSH_PORT"
else
  fail "UFW does not allow TCP $SSH_PORT"
fi
# The Cloudflare Tunnel connects outbound, so inbound web ports must stay closed (ADR 0012).
for port in 80 443; do
  if ufw status | grep -Eq "^${port}/tcp[[:space:]]+ALLOW"; then
    fail "UFW still allows TCP $port; remove it with 'ufw delete allow ${port}/tcp'"
  else
    pass "UFW does not allow TCP $port"
  fi
done

PUBLISHED_HOST_PORTS="$(docker ps --format '{{.Ports}}' | grep -Eo '(0\.0\.0\.0|\[::\]):[0-9]+' || true)"
if [[ -n "$PUBLISHED_HOST_PORTS" ]]; then
  fail "Docker publishes all-interface host ports: $(printf '%s' "$PUBLISHED_HOST_PORTS" | tr '\n' ' ')"
else
  pass 'no Docker container publishes all-interface ports'
fi

if ((FAILURES)); then
  printf '\nVerification failed with %s issue(s). Do not close the existing administrative SSH session.\n' "$FAILURES" >&2
  exit 1
fi
printf '\nBaseline verification passed. Manually confirm a second key-based SSH login before ending the original session.\n'
