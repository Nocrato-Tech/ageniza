#!/usr/bin/env bash
# Fixed root-owned production deployment entrypoint. Install; never run from a Git checkout.
# Production secrets live only on this host (ADR 0010 amendment). GitHub sends a commit SHA
# and a workflow run ID; this script verifies both against GitHub before changing anything.
# Releases replace containers in place (a few seconds of downtime); Caddy routes to fixed names.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_PROJECT=ageniza
readonly APP_ROOT=/opt/ageniza
readonly APP_COMPOSE="$APP_ROOT/compose.yml"
readonly PRODUCTION_COMPOSE="$APP_ROOT/compose.production.yml"
readonly CONFIG_DIR=/etc/ageniza
readonly DEPLOY_CONFIG="$CONFIG_DIR/deploy.env"
readonly RUNTIME_ENV="$CONFIG_DIR/runtime.env"
readonly MIGRATIONS_ENV="$CONFIG_DIR/migrations.env"
readonly GITHUB_TOKEN_FILE="$CONFIG_DIR/github-token"
readonly REGISTRY_CONFIG="$CONFIG_DIR/registry"
readonly RELEASE_DIR=/var/lib/ageniza/releases
readonly LOCK_FILE=/run/lock/ageniza-deploy.lock
readonly GITHUB_API=https://api.github.com
readonly RELEASE_WORKFLOW=.github/workflows/production.yml

WORK_DIR=''
RESTORE_ARMED=false
REPOSITORY='' IMAGE_NAMESPACE=''
RELEASE='' RUN_ID='' RUNTIME_SNAPSHOT=''
API_IMAGE='' WEB_IMAGE='' WORKER_IMAGE='' MIGRATIONS_IMAGE=''

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'ageniza-deploy: %s\n' "$*"; }
require_root() { [[ $EUID -eq 0 ]] || die 'must run as root via the fixed sudo rule'; }
valid_release() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
valid_run_id() { [[ "$1" =~ ^[1-9][0-9]{0,19}$ ]]; }

usage() {
  cat <<'USAGE'
Usage:
  ageniza-deploy apply <40-hex-commit-sha> <github-run-id>
  ageniza-deploy rollback
  ageniza-deploy status

apply deploys only the release-manifest artifact of a push-to-main run of
.github/workflows/production.yml for a commit that is on main.
USAGE
}

require_root_file() {
  local file="$1" modes="$2"
  [[ -f "$file" && ! -L "$file" ]] || die "expected regular file: $file"
  [[ "$(stat -c '%u:%a' "$file")" =~ ^0:($modes)$ ]] || die "unsafe ownership or mode (want root and $modes): $file"
}

read_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); found = 1; exit } END { exit !found }' "$file"
}

config_value() { read_value "$DEPLOY_CONFIG" "$1" || die "missing $1 in $DEPLOY_CONFIG"; }

load_deploy_config() {
  require_root_file "$DEPLOY_CONFIG" '600|640|644'
  REPOSITORY="$(config_value AGENIZA_REPOSITORY)"
  IMAGE_NAMESPACE="$(config_value AGENIZA_IMAGE_NAMESPACE)"
  [[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'AGENIZA_REPOSITORY must be <owner>/<name>'
  [[ "$IMAGE_NAMESPACE" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*$ ]] || die 'AGENIZA_IMAGE_NAMESPACE must be ghcr.io/<lowercase-owner>'
}

# Application images must come from this repository's own GHCR namespace, pinned by digest.
valid_app_image() {
  local prefix="$IMAGE_NAMESPACE/ageniza-$1@sha256:"
  [[ "$2" == "$prefix"* && "${2#"$prefix"}" =~ ^[a-f0-9]{64}$ ]]
}

validate_runtime_env() {
  local line key value required
  declare -A seen=()
  require_root_file "$RUNTIME_ENV" '600'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    [[ "$line" == *=* ]] || die "$RUNTIME_ENV must contain KEY=value lines only (no comments)"
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "$RUNTIME_ENV contains an invalid key"
    [[ -z "${seen[$key]+x}" ]] || die "$RUNTIME_ENV repeats $key"
    seen[$key]=1
    case "$key" in
      APP_ENV) [[ "$value" == production ]] || die 'APP_ENV must be production' ;;
      WORKER_SMOKE_JOB) [[ "$value" == false ]] || die 'WORKER_SMOKE_JOB must be false' ;;
      DATABASE_URL|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|API_CORS_ORIGINS|API_TRUSTED_PROXY_CIDRS) [[ -n "$value" ]] || die "$key must not be blank" ;;
      SENTRY_DSN) ;;
      *) die "$RUNTIME_ENV contains a key that is not allowed: $key" ;;
    esac
  done < "$RUNTIME_ENV"
  for required in APP_ENV DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_CORS_ORIGINS API_TRUSTED_PROXY_CIDRS WORKER_SMOKE_JOB; do
    [[ -n "${seen[$required]+x}" ]] || die "$RUNTIME_ENV is missing $required"
  done
}

prepare_github_access() {
  local token
  require_root_file "$GITHUB_TOKEN_FILE" '600'
  WORK_DIR="$(mktemp -d /run/ageniza-deploy.XXXXXX)"
  token="$(tr -d '[:space:]' < "$GITHUB_TOKEN_FILE")"
  [[ -n "$token" ]] || die "$GITHUB_TOKEN_FILE is empty"
  # Headers go through a 0600 file so the token never appears in the process list.
  printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: ageniza-deploy\n' "$token" > "$WORK_DIR/github-headers"
}

github_api() {
  # curl does not forward the Authorization header when an artifact download redirects to storage.
  curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-time 60 --location \
    --header @"$WORK_DIR/github-headers" --output "$2" "$1"
}

fetch_verified_release() {
  local sha="$1" run_id="$2" repository_lower="${REPOSITORY,,}" compare_status url
  github_api "$GITHUB_API/repos/$REPOSITORY/actions/runs/$run_id" "$WORK_DIR/run.json" || die "cannot read workflow run $run_id from GitHub"
  jq -e --arg sha "$sha" --arg repo "$repository_lower" --arg workflow "$RELEASE_WORKFLOW" '
    .head_sha == $sha and .head_branch == "main" and .event == "push"
    and ((.path // "") | split("@")[0]) == $workflow
    and ((.repository.full_name // "") | ascii_downcase) == $repo
    and ((.head_repository.full_name // "") | ascii_downcase) == $repo' "$WORK_DIR/run.json" >/dev/null \
    || die "run $run_id is not a push-to-main run of $RELEASE_WORKFLOW for $sha"

  github_api "$GITHUB_API/repos/$REPOSITORY/compare/$sha...main" "$WORK_DIR/compare.json" || die "cannot compare $sha with main"
  compare_status="$(jq -r '.status' "$WORK_DIR/compare.json")"
  [[ "$compare_status" == identical || "$compare_status" == ahead ]] || die "release $sha is not on main (compare status: $compare_status)"

  github_api "$GITHUB_API/repos/$REPOSITORY/actions/runs/$run_id/artifacts?name=release-manifest" "$WORK_DIR/artifacts.json" || die 'cannot list release artifacts'
  url="$(jq -r '[.artifacts[] | select(.name == "release-manifest" and (.expired | not))][0].archive_download_url // ""' "$WORK_DIR/artifacts.json")"
  [[ "${url,,}" == "$GITHUB_API/repos/$repository_lower/actions/artifacts/"* ]] || die "run $run_id has no release-manifest artifact"
  github_api "$url" "$WORK_DIR/release.zip" || die 'cannot download the release manifest'
  unzip -p "$WORK_DIR/release.zip" release.env > "$WORK_DIR/release.env" || die 'release manifest archive is invalid'

  [[ "$(read_value "$WORK_DIR/release.env" RELEASE || true)" == "$sha" ]] || die 'release manifest does not match the requested commit'
  API_IMAGE="$(read_value "$WORK_DIR/release.env" API_IMAGE || true)"
  WEB_IMAGE="$(read_value "$WORK_DIR/release.env" WEB_IMAGE || true)"
  WORKER_IMAGE="$(read_value "$WORK_DIR/release.env" WORKER_IMAGE || true)"
  MIGRATIONS_IMAGE="$(read_value "$WORK_DIR/release.env" MIGRATIONS_IMAGE || true)"
  valid_app_image api "$API_IMAGE" || die "manifest API image is not an $IMAGE_NAMESPACE digest"
  valid_app_image web "$WEB_IMAGE" || die "manifest web image is not an $IMAGE_NAMESPACE digest"
  valid_app_image worker "$WORKER_IMAGE" || die "manifest worker image is not an $IMAGE_NAMESPACE digest"
  valid_app_image migrations "$MIGRATIONS_IMAGE" || die "manifest migrations image is not an $IMAGE_NAMESPACE digest"
}

pull_verified_image() {
  docker --config "$REGISTRY_CONFIG" pull --quiet "$1" >/dev/null || die "cannot pull $1"
  docker image inspect "$1" --format '{{join .RepoDigests "\n"}}' | grep -Fx -- "$1" >/dev/null || die "pulled image does not retain the requested digest: $1"
}

compose_app() {
  AGENIZA_RUNTIME_ENV_FILE="$RUNTIME_SNAPSHOT" \
    AGENIZA_API_IMAGE="$API_IMAGE" AGENIZA_WEB_IMAGE="$WEB_IMAGE" AGENIZA_WORKER_IMAGE="$WORKER_IMAGE" \
    docker compose -p "$APP_PROJECT" -f "$APP_COMPOSE" -f "$PRODUCTION_COMPOSE" "$@"
}

# Replaces api, web, and worker with the loaded release and waits for private health.
start_release() {
  compose_app up -d --pull never --wait --wait-timeout 180 api web worker
  compose_app exec -T api node -e "fetch('http://127.0.0.1:3001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  compose_app exec -T web wget -q -O /dev/null http://127.0.0.1:8080/health
  compose_app exec -T worker node -e "fetch('http://127.0.0.1:3002/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

load_manifest() {
  local file="$1"
  RELEASE="$(read_value "$file" RELEASE || true)"
  RUN_ID="$(read_value "$file" RUN_ID || true)"
  API_IMAGE="$(read_value "$file" API_IMAGE || true)"
  WEB_IMAGE="$(read_value "$file" WEB_IMAGE || true)"
  WORKER_IMAGE="$(read_value "$file" WORKER_IMAGE || true)"
  MIGRATIONS_IMAGE="$(read_value "$file" MIGRATIONS_IMAGE || true)"
  RUNTIME_SNAPSHOT="$(read_value "$file" RUNTIME_ENV_FILE || true)"
  valid_release "$RELEASE" \
    && valid_app_image api "$API_IMAGE" && valid_app_image web "$WEB_IMAGE" && valid_app_image worker "$WORKER_IMAGE" \
    && [[ "$RUNTIME_SNAPSHOT" == "$RELEASE_DIR/$RELEASE.env" && -f "$RUNTIME_SNAPSHOT" ]]
}

write_current_manifest() {
  local temporary
  temporary="$(mktemp "$RELEASE_DIR/.manifest.XXXXXX")"
  printf 'RELEASE=%s\nRUN_ID=%s\nAPI_IMAGE=%s\nWEB_IMAGE=%s\nWORKER_IMAGE=%s\nMIGRATIONS_IMAGE=%s\nRUNTIME_ENV_FILE=%s\nDEPLOYED_AT=%s\n' \
    "$RELEASE" "$RUN_ID" "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE" "$MIGRATIONS_IMAGE" "$RUNTIME_SNAPSHOT" "$(date -u +%FT%TZ)" > "$temporary"
  if [[ -f "$RELEASE_DIR/current.env" ]]; then install -o root -g root -m 0600 "$RELEASE_DIR/current.env" "$RELEASE_DIR/previous.env"; fi
  install -o root -g root -m 0600 "$temporary" "$RELEASE_DIR/current.env"
  rm -f -- "$temporary"
}

# Each release runs with the runtime.env snapshot taken when it was applied, so a bad edit to
# runtime.env cannot break the restore or rollback of an older release.
prune_runtime_snapshots() {
  local keep_current keep_previous file
  keep_current="$(read_value "$RELEASE_DIR/current.env" RUNTIME_ENV_FILE || true)"
  keep_previous="$(read_value "$RELEASE_DIR/previous.env" RUNTIME_ENV_FILE || true)"
  for file in "$RELEASE_DIR"/*.env; do
    case "$file" in */current.env|*/previous.env) continue ;; esac
    [[ -f "$file" ]] || continue
    [[ "$file" == "$keep_current" || "$file" == "$keep_previous" ]] || rm -f -- "$file"
  done
}

restore_live_release() {
  if ! load_manifest "$RELEASE_DIR/current.env"; then
    note 'apply failed and there is no valid live release to restore'
    return 0
  fi
  note "apply failed; restarting live release $RELEASE"
  start_release || note 'restore failed; run the Production rollback workflow or inspect the host'
}

on_exit() {
  local status=$?
  if [[ $status -ne 0 && "$RESTORE_ARMED" == true ]]; then
    RESTORE_ARMED=false
    restore_live_release || true
  fi
  if [[ -n "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  exit "$status"
}

apply() {
  local sha="$1" run_id="$2" image
  load_deploy_config
  if [[ "$(read_value "$RELEASE_DIR/current.env" RELEASE || true)" == "$sha" ]]; then
    note "release $sha is already active"
    return 0
  fi
  validate_runtime_env
  require_root_file "$MIGRATIONS_ENV" '600'
  [[ -n "$(read_value "$MIGRATIONS_ENV" MIGRATION_DATABASE_URL || true)" ]] || die "$MIGRATIONS_ENV must set MIGRATION_DATABASE_URL"

  prepare_github_access
  fetch_verified_release "$sha" "$run_id"
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE" "$MIGRATIONS_IMAGE"; do pull_verified_image "$image"; done

  RELEASE="$sha"; RUN_ID="$run_id"; RUNTIME_SNAPSHOT="$RELEASE_DIR/$sha.env"
  install -o root -g root -m 0600 "$RUNTIME_ENV" "$RUNTIME_SNAPSHOT"

  note "applying forward-only migrations for $sha"
  docker run --rm --pull never --env-file "$MIGRATIONS_ENV" "$MIGRATIONS_IMAGE" || die 'migrations failed; the live release was not changed'

  RESTORE_ARMED=true
  note "replacing containers with release $sha"
  start_release
  write_current_manifest
  RESTORE_ARMED=false
  prune_runtime_snapshots
  note "release $sha is active"
}

rollback() {
  local live_release image
  load_deploy_config
  live_release="$(read_value "$RELEASE_DIR/current.env" RELEASE || true)"
  load_manifest "$RELEASE_DIR/previous.env" || die 'no valid previous release manifest and runtime snapshot exist'
  [[ "$RELEASE" != "$live_release" ]] || die "release $RELEASE is already live; there is no older release to roll back to"
  require_root_file "$RUNTIME_SNAPSHOT" '600'
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE"; do pull_verified_image "$image"; done
  note "rolling back to $RELEASE"
  start_release
  install -o root -g root -m 0600 "$RELEASE_DIR/previous.env" "$RELEASE_DIR/current.env"
  note "rollback activated release $RELEASE; schema was not changed"
}

print_status() {
  local release
  release="$(read_value "$RELEASE_DIR/current.env" RELEASE || true)"
  printf 'RELEASE=%s\n' "${release:-none}"
}

take_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || die 'another deployment or rollback holds the host lock'
}

main() {
  require_root
  install -d -o root -g root -m 0700 "$RELEASE_DIR"
  trap on_exit EXIT
  case "${1:-}" in
    status)
      [[ $# -eq 1 ]] || die 'status accepts no arguments'
      print_status
      return
      ;;
    apply|rollback)
      [[ -f "$APP_COMPOSE" && -f "$PRODUCTION_COMPOSE" ]] || die 'deployment bundle is incomplete; re-run install-production-deploy.sh'
      ;;
    -h|--help|'') usage; return ;;
    *) die 'unknown command' ;;
  esac
  take_lock
  if [[ "$1" == apply ]]; then
    [[ $# -eq 3 ]] || die 'usage: ageniza-deploy apply <40-hex-commit-sha> <github-run-id>'
    valid_release "$2" || die 'release must be a 40-character lowercase commit SHA'
    valid_run_id "$3" || die 'run ID must be a positive integer'
    apply "$2" "$3"
  else
    [[ $# -eq 1 ]] || die 'rollback accepts no arguments'
    rollback
  fi
}

main "$@"
