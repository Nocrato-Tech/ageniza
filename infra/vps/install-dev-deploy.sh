#!/usr/bin/env bash
# Root installer for the reviewed DEV deployment bundle (ADR 0013). Run on the VPS from a reviewed checkout; safe to re-run.
# It touches nothing of production: its own account, directories, sudo rule, and tunnel config.
set -Eeuo pipefail
IFS=$'\n\t'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Fills the two Cloudflare Access values of the Mailpit hostname. cloudflared uses them to refuse any request that did
# not pass Access, so a value that is not what Cloudflare issues must stop the install instead of producing a config
# that lets requests through or locks everything out.
render_access_config() {
  local template="$1" team="$2" aud="$3"
  [[ "$team" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die 'AGENIZA_ACCESS_TEAM_NAME must be the Zero Trust team name (lowercase letters, digits and hyphens)'
  [[ "$aud" =~ ^[a-f0-9]{64}$ ]] || die 'AGENIZA_ACCESS_AUD_TAG must be the 64-character application audience tag'
  sed -e "s/REPLACE_WITH_ACCESS_TEAM_NAME/$team/" -e "s/REPLACE_WITH_ACCESS_AUD_TAG/$aud/" "$template"
}

install_cloudflared_config() {
  local source_dir="$1" deploy_env="$2" team aud rendered temporary
  if [[ ! -f "$deploy_env" ]]; then
    printf 'NOTE: %s does not exist yet; the tunnel config is installed when you re-run this script after creating it.\n' "$deploy_env"
    return 0
  fi
  team="$(awk -F= '$1 == "AGENIZA_ACCESS_TEAM_NAME" { print substr($0, length($1) + 2); exit }' "$deploy_env")"
  aud="$(awk -F= '$1 == "AGENIZA_ACCESS_AUD_TAG" { print substr($0, length($1) + 2); exit }' "$deploy_env")"
  rendered="$(render_access_config "$source_dir/cloudflared/dev-config.yml" "$team" "$aud")"
  grep -q 'REPLACE_WITH' <<< "$rendered" && die 'the rendered tunnel config still has a placeholder'
  temporary="$(mktemp)"
  printf '%s\n' "$rendered" > "$temporary"
  install -o root -g root -m 0644 "$temporary" /etc/ageniza-dev/cloudflared/config.yml
  rm -f -- "$temporary"
}

main() {
  [[ $EUID -eq 0 ]] || die 'Run as root.'
  local source_dir repository_root file
  source_dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  repository_root="$(cd "$source_dir/../.." && pwd)"
  local -r ci_user=ageniza-dev-ci app_root=/opt/ageniza-dev

  for file in \
    "$source_dir/ageniza-deploy-dev.sh" "$source_dir/ageniza-deploy-dev-ssh.sh" "$source_dir/ageniza-deploy-dev.sudoers" \
    "$source_dir/compose.dev-tunnel.yml" "$source_dir/cloudflared/dev-config.yml" "$source_dir/dev-limits.env" \
    "$repository_root/compose.yml" "$repository_root/compose.dev.yml" \
    "$repository_root/infra/postgres/initdb/10-application-role.sh"; do
    [[ -f "$file" && ! -L "$file" ]] || die "Missing required bundle file: $file"
  done
  # Validate before installing: a broken file in /etc/sudoers.d disables sudo host-wide.
  visudo -cf "$source_dir/ageniza-deploy-dev.sudoers" >/dev/null || die 'sudoers rule is invalid; nothing was installed'
  command -v docker >/dev/null || die 'Docker is not installed; run bootstrap-ubuntu.sh first'

  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl jq unzip >/dev/null

  # Dedicated account for the dev key: no sudo group, no Docker group, forced command only, and a sudo rule that
  # names the dev entrypoint alone.
  if ! id "$ci_user" >/dev/null 2>&1; then
    adduser --disabled-password --gecos '' --shell /bin/bash "$ci_user"
  fi
  install -d -o "$ci_user" -g "$ci_user" -m 0700 "/home/$ci_user/.ssh"
  [[ -f "/home/$ci_user/.ssh/authorized_keys" ]] || install -o "$ci_user" -g "$ci_user" -m 0600 /dev/null "/home/$ci_user/.ssh/authorized_keys"

  install -d -o root -g root -m 0750 "$app_root" /etc/ageniza-dev /etc/ageniza-dev/cloudflared
  install -d -o root -g root -m 0755 "$app_root/postgres" "$app_root/postgres/initdb"
  install -o root -g root -m 0755 "$repository_root/infra/postgres/initdb/10-application-role.sh" "$app_root/postgres/initdb/10-application-role.sh"
  install -d -o root -g root -m 0700 /etc/ageniza-dev/registry /var/lib/ageniza-dev/releases
  install -o root -g root -m 0755 "$source_dir/ageniza-deploy-dev.sh" /usr/local/sbin/ageniza-deploy-dev
  install -o root -g root -m 0755 "$source_dir/ageniza-deploy-dev-ssh.sh" /usr/local/sbin/ageniza-deploy-dev-ssh
  install -o root -g root -m 0644 "$repository_root/compose.yml" "$app_root/compose.yml"
  install -o root -g root -m 0644 "$repository_root/compose.dev.yml" "$app_root/compose.dev.yml"
  install -o root -g root -m 0644 "$source_dir/dev-limits.env" "$app_root/dev-limits.env"
  install -o root -g root -m 0644 "$source_dir/compose.dev-tunnel.yml" "$app_root/compose.dev-tunnel.yml"
  install -o root -g root -m 0440 "$source_dir/ageniza-deploy-dev.sudoers" /etc/sudoers.d/ageniza-deploy-dev
  docker network inspect ageniza-dev-proxy >/dev/null 2>&1 || docker network create ageniza-dev-proxy >/dev/null
  install_cloudflared_config "$source_dir" /etc/ageniza-dev/dev-deploy.env

  cat <<EOF
Installed the dev deployment bundle. Finish the host setup from docs/infra/dev-environment.md:
  - /etc/ageniza-dev/dev-deploy.env, postgres.env, runtime.env, migrations.env, and github-token
  - GHCR login into /etc/ageniza-dev/registry
  - the dev GitHub Actions public key in /home/$ci_user/.ssh/authorized_keys with the forced command
  - /etc/ageniza-dev/cloudflared/credentials.json (0600) for the DEV tunnel, then re-run this script and start the tunnel
EOF
}

# Sourcing the file (the tests do) defines the functions without installing anything.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
