#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key. Install as /usr/local/sbin/ageniza-deploy-ssh and
# reference it from authorized_keys: restrict,command="/usr/local/sbin/ageniza-deploy-ssh" <public key>
# The key can run only these operations; the SSH command string is never evaluated by a shell.
set -Eeuo pipefail
IFS=' '

read -r -a words <<< "${SSH_ORIGINAL_COMMAND:-}"
case "${words[0]:-}" in
  apply)
    if [[ ${#words[@]} -ne 3 || ! ${words[1]} =~ ^[a-f0-9]{40}$ || ! ${words[2]} =~ ^[1-9][0-9]{0,19}$ ]]; then
      echo 'usage: apply <40-hex-commit-sha> <github-run-id>' >&2
      exit 64
    fi
    exec sudo -n /usr/local/sbin/ageniza-deploy apply "${words[1]}" "${words[2]}"
    ;;
  rollback|status)
    if [[ ${#words[@]} -ne 1 ]]; then
      echo "usage: ${words[0]}" >&2
      exit 64
    fi
    exec sudo -n /usr/local/sbin/ageniza-deploy "${words[0]}"
    ;;
  *)
    echo 'only apply, rollback, and status are allowed for this key' >&2
    exit 64
    ;;
esac
