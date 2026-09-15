#!/usr/bin/env bash
# Fixed root-owned production deployment entrypoint. Install; never run from a Git checkout.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_ROOT=/opt/ageniza
readonly APP_COMPOSE="$APP_ROOT/compose.yml"
readonly PRODUCTION_COMPOSE="$APP_ROOT/compose.production.yml"
readonly CADDY_COMPOSE="$APP_ROOT/compose.caddy.yml"
readonly RUNTIME_ENV=/etc/ageniza/runtime.env
readonly CADDY_ENV=/etc/ageniza/caddy/caddy.env
readonly REGISTRY_CONFIG=/etc/ageniza/registry
readonly RELEASE_DIR=/var/lib/ageniza/releases
readonly LOCK_FILE=/run/lock/ageniza-deploy.lock

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'ageniza-deploy: %s\n' "$*"; }
require_root() { [[ $EUID -eq 0 ]] || die 'must run as root via the fixed sudo rule'; }
require_regular_root_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || die "expected regular file: $file"
  [[ "$(stat -c '%u:%a' "$file")" =~ ^0:(600|640|644|700|750|755)$ ]] || die "unsafe ownership or mode: $file"
}
valid_image() { [[ "$1" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$ ]]; }
valid_release() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
valid_color() { [[ "$1" == blue || "$1" == green ]]; }

usage() {
  cat <<'USAGE'
Usage:
  ageniza-deploy apply --release <40-lowercase-sha> --api-image <ghcr-digest> --web-image <ghcr-digest> --worker-image <ghcr-digest>
  ageniza-deploy rollback

For apply, production runtime configuration and the GHCR pull token arrive only on stdin.
USAGE
}

load_caddy_environment() {
  require_regular_root_file "$CADDY_ENV"
  # This file is installed and root-writable only; it contains only Caddy's public domain and immutable image.
  # shellcheck disable=SC1090
  source "$CADDY_ENV"
  : "${AGENIZA_CADDY_IMAGE:?missing AGENIZA_CADDY_IMAGE in $CADDY_ENV}"
  : "${AGENIZA_DOMAIN:?missing AGENIZA_DOMAIN in $CADDY_ENV}"
  [[ "$AGENIZA_CADDY_IMAGE" =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$ ]] || die 'Caddy image must be pinned by a lowercase sha256 digest'
  [[ "$AGENIZA_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die 'Caddy domain is invalid'
  export AGENIZA_CADDY_IMAGE AGENIZA_DOMAIN
}

compose_candidate() {
  local color="$1"; shift
  AGENIZA_COLOR="$color" AGENIZA_RUNTIME_ENV_FILE="$RUNTIME_ENV" \
    AGENIZA_API_IMAGE="$API_IMAGE" AGENIZA_WEB_IMAGE="$WEB_IMAGE" AGENIZA_WORKER_IMAGE="$WORKER_IMAGE" \
    docker compose -p "ageniza-$color" -f "$APP_COMPOSE" -f "$PRODUCTION_COMPOSE" "$@"
}

compose_worker() {
  AGENIZA_COLOR=blue AGENIZA_RUNTIME_ENV_FILE="$RUNTIME_ENV" \
    AGENIZA_API_IMAGE="$API_IMAGE" AGENIZA_WEB_IMAGE="$WEB_IMAGE" AGENIZA_WORKER_IMAGE="$WORKER_IMAGE" \
    docker compose -p ageniza-worker -f "$APP_COMPOSE" -f "$PRODUCTION_COMPOSE" "$@"
}

image_present_as_requested() {
  local image="$1"
  docker image inspect "$image" --format '{{join .RepoDigests "\n"}}' | grep -Fx -- "$image" >/dev/null
}

wait_private_health() {
  local color="$1"
  compose_candidate "$color" exec -T api node -e "fetch('http://127.0.0.1:3001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  compose_candidate "$color" exec -T web wget -q -O /dev/null http://127.0.0.1:8080/health
  compose_worker exec -T worker node -e "fetch('http://127.0.0.1:3002/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

write_active_upstream() {
  local color="$1" temporary
  temporary="$(mktemp /etc/ageniza/caddy/.active-upstream.XXXXXX)"
  cat > "$temporary" <<EOF
handle_path /api/* {
    reverse_proxy api-$color:3001
}

handle {
    reverse_proxy web-$color:8080
}
EOF
  install -o root -g root -m 0644 "$temporary" /etc/ageniza/caddy/active-upstream.caddy
  rm -f "$temporary"
}

reload_caddy() {
  local color="$1"
  write_active_upstream "$color"
  docker compose -p ageniza-edge -f "$CADDY_COMPOSE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  docker compose -p ageniza-edge -f "$CADDY_COMPOSE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

read_manifest_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$file"
}

write_manifest() {
  local destination="$1" color="$2" temporary
  temporary="$(mktemp "$RELEASE_DIR/.manifest.XXXXXX")"
  {
    printf 'RELEASE=%s\n' "$RELEASE"
    printf 'ACTIVE_COLOR=%s\n' "$color"
    printf 'API_IMAGE=%s\n' "$API_IMAGE"
    printf 'WEB_IMAGE=%s\n' "$WEB_IMAGE"
    printf 'WORKER_IMAGE=%s\n' "$WORKER_IMAGE"
    printf 'DEPLOYED_AT=%s\n' "$(date -u +%FT%TZ)"
  } > "$temporary"
  install -o root -g root -m 0600 "$temporary" "$destination"
  rm -f "$temporary"
}

install_runtime_from_stdin() {
  local incoming cleaned line key value ghcr_token='' required_key temporary
  incoming="$(mktemp /etc/ageniza/.runtime-incoming.XXXXXX)"
  cleaned="$(mktemp /etc/ageniza/.runtime-clean.XXXXXX)"
  cat > "$incoming"
  declare -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die 'runtime input must contain KEY=value lines only'
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die 'runtime input contains an invalid key'
    [[ -z "${seen[$key]+x}" ]] || die "runtime input repeats $key"
    seen[$key]=1
    case "$key" in
      APP_ENV) [[ "$value" == production ]] || die 'APP_ENV must be production'; printf '%s\n' "$line" >> "$cleaned" ;;
      DATABASE_URL|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|API_CORS_ORIGINS|API_TRUSTED_PROXY_CIDRS|SENTRY_DSN) printf '%s\n' "$line" >> "$cleaned" ;;
      WORKER_SMOKE_JOB) [[ "$value" == false ]] || die 'WORKER_SMOKE_JOB must be false'; printf '%s\n' "$line" >> "$cleaned" ;;
      GHCR_PULL_TOKEN) [[ -n "$value" ]] || die 'GHCR_PULL_TOKEN must not be blank'; ghcr_token="$value" ;;
      *) die "runtime input key is not allowed: $key" ;;
    esac
  done < "$incoming"
  rm -f "$incoming"
  for required_key in APP_ENV DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_CORS_ORIGINS API_TRUSTED_PROXY_CIDRS WORKER_SMOKE_JOB; do
    [[ -n "${seen[$required_key]+x}" ]] || die "runtime input is missing $required_key"
  done
  [[ -n "$ghcr_token" ]] || die 'runtime input is missing GHCR_PULL_TOKEN'
  printf 'APP_VERSION=%s\n' "$RELEASE" >> "$cleaned"
  install -d -o root -g root -m 0700 "$REGISTRY_CONFIG" "$RELEASE_DIR"
  printf '%s' "$ghcr_token" | docker --config "$REGISTRY_CONFIG" login ghcr.io --username x-access-token --password-stdin >/dev/null
  install -o root -g root -m 0600 "$cleaned" "$RUNTIME_ENV"
  rm -f "$cleaned"
}

restore_live_release_after_failed_apply() {
  local status=$? live="$RELEASE_DIR/current.env" color
  [[ $status -ne 0 && "$APPLY_ACTIVATED" != true ]] || return 0
  if [[ ! -f "$live" ]]; then
    note 'apply failed before the first release was activated; nothing to restore'
    return 0
  fi
  color="$(read_manifest_value "$live" ACTIVE_COLOR || true)"
  valid_color "$color" || { note 'apply failed and the current manifest is invalid; restore manually'; return 0; }
  API_IMAGE="$(read_manifest_value "$live" API_IMAGE || true)"
  WEB_IMAGE="$(read_manifest_value "$live" WEB_IMAGE || true)"
  WORKER_IMAGE="$(read_manifest_value "$live" WORKER_IMAGE || true)"
  note "apply failed; restoring the live release worker and Caddy target ($color)"
  # The previous color's web/API were never touched; only the worker and Caddy may have moved.
  compose_worker up -d --wait --wait-timeout 120 --force-recreate worker || note 'worker restore failed; run the production rollback workflow'
  reload_caddy "$color" || note 'Caddy restore failed; run the production rollback workflow'
}

apply() {
  local next_color current_color
  APPLY_ACTIVATED=false
  install_runtime_from_stdin
  load_caddy_environment
  trap restore_live_release_after_failed_apply EXIT
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do
    docker --config "$REGISTRY_CONFIG" pull "$image" >/dev/null
    image_present_as_requested "$image" || die "pulled image does not retain requested digest: $image"
  done
  current_color="$(read_manifest_value "$RELEASE_DIR/current.env" ACTIVE_COLOR || true)"
  if [[ "$current_color" == blue ]]; then next_color=green; else next_color=blue; fi
  note "starting $next_color candidate for $RELEASE"
  compose_candidate "$next_color" up -d --wait --wait-timeout 120 api web
  # The present worker has no durable dispatcher; replace one private process under this host lock.
  compose_worker up -d --wait --wait-timeout 120 --force-recreate worker
  wait_private_health "$next_color"
  reload_caddy "$next_color"
  if [[ -f "$RELEASE_DIR/current.env" ]]; then install -o root -g root -m 0600 "$RELEASE_DIR/current.env" "$RELEASE_DIR/previous.env"; fi
  write_manifest "$RELEASE_DIR/current.env" "$next_color"
  APPLY_ACTIVATED=true
  note "release $RELEASE is active on $next_color"
}

rollback() {
  local previous_color previous_release
  load_caddy_environment
  previous_color="$(read_manifest_value "$RELEASE_DIR/previous.env" ACTIVE_COLOR || true)"
  previous_release="$(read_manifest_value "$RELEASE_DIR/previous.env" RELEASE || true)"
  valid_color "$previous_color" || die 'no valid previous release manifest exists'
  valid_release "$previous_release" || die 'previous release manifest is invalid'
  API_IMAGE="$(read_manifest_value "$RELEASE_DIR/previous.env" API_IMAGE || true)"
  WEB_IMAGE="$(read_manifest_value "$RELEASE_DIR/previous.env" WEB_IMAGE || true)"
  WORKER_IMAGE="$(read_manifest_value "$RELEASE_DIR/previous.env" WORKER_IMAGE || true)"
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do valid_image "$image" || die 'previous manifest has an invalid image reference'; done
  RELEASE="$previous_release"
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do
    docker --config "$REGISTRY_CONFIG" pull "$image" >/dev/null
    image_present_as_requested "$image" || die "previous image digest cannot be verified: $image"
  done
  compose_candidate "$previous_color" up -d --wait --wait-timeout 120 --force-recreate api web
  compose_worker up -d --wait --wait-timeout 120 --force-recreate worker
  wait_private_health "$previous_color"
  reload_caddy "$previous_color"
  install -o root -g root -m 0600 "$RELEASE_DIR/previous.env" "$RELEASE_DIR/current.env"
  note "rollback activated release $RELEASE on $previous_color; schema was not changed"
}

main() {
  require_root
  [[ -f "$APP_COMPOSE" && -f "$PRODUCTION_COMPOSE" && -f "$CADDY_COMPOSE" ]] || die 'deployment bundle is incomplete'
  install -d -o root -g root -m 0750 /etc/ageniza /etc/ageniza/caddy
  exec 9>"$LOCK_FILE"
  flock -n 9 || die 'another deployment or rollback holds the host lock'
  case "${1:-}" in
    apply)
      shift
      RELEASE=''; API_IMAGE=''; WEB_IMAGE=''; WORKER_IMAGE=''
      while (($#)); do
        case "$1" in
          --release) RELEASE="${2:-}"; shift 2 ;;
          --api-image) API_IMAGE="${2:-}"; shift 2 ;;
          --web-image) WEB_IMAGE="${2:-}"; shift 2 ;;
          --worker-image) WORKER_IMAGE="${2:-}"; shift 2 ;;
          *) die 'only the documented apply arguments are accepted' ;;
        esac
      done
      valid_release "$RELEASE" || die 'release must be a 40-character lowercase commit SHA'
      for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do valid_image "$image" || die 'application images must be exact lowercase GHCR digest references'; done
      apply
      ;;
    rollback)
      [[ $# -eq 1 ]] || die 'rollback accepts no arguments'
      rollback
      ;;
    -h|--help|'') usage ;;
    *) die 'unknown command' ;;
  esac
}

main "$@"
