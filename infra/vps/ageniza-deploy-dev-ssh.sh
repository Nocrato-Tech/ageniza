#!/usr/bin/env bash
# Forced command for the dev deploy key (ADR 0013). Install as /usr/local/sbin/ageniza-deploy-dev-ssh and reference it
# from the authorized_keys of the ageniza-dev-ci account: restrict,command="/usr/local/sbin/ageniza-deploy-dev-ssh" <public key>
# The key can run only these two operations, and only the dev entrypoint: it has no way to name a production one.
# The SSH command string is never evaluated by a shell.
set -Eeuo pipefail
IFS=' '

read -r -a words <<< "${SSH_ORIGINAL_COMMAND:-}"
case "${words[0]:-}" in
  apply-dev)
    if [[ ${#words[@]} -ne 3 || ! ${words[1]} =~ ^[a-f0-9]{40}$ || ! ${words[2]} =~ ^[1-9][0-9]{0,19}$ ]]; then
      echo 'usage: apply-dev <40-hex-commit-sha> <github-run-id>' >&2
      exit 64
    fi
    exec sudo -n /usr/local/sbin/ageniza-deploy-dev apply-dev "${words[1]}" "${words[2]}"
    ;;
  status-dev)
    if [[ ${#words[@]} -ne 1 ]]; then
      echo 'usage: status-dev' >&2
      exit 64
    fi
    exec sudo -n /usr/local/sbin/ageniza-deploy-dev status-dev
    ;;
  *)
    echo 'only apply-dev and status-dev are allowed for this key' >&2
    exit 64
    ;;
esac
