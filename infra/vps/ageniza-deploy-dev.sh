#!/usr/bin/env bash
# Fixed root-owned deployment entrypoint of the DEV environment (ADR 0013). Install; never run from a Git checkout.
# It is a separate program from ageniza-deploy: its own account, sudo rule, lock, directories, Compose project and
# secrets, so the key that can deploy dev can never apply a production release (and the reverse).
# GitHub sends a commit SHA and a workflow run ID; this script verifies both against GitHub before changing anything.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_PROJECT=ageniza-dev
readonly APP_ROOT=/opt/ageniza-dev
readonly APP_COMPOSE="$APP_ROOT/compose.yml"
readonly DEV_COMPOSE="$APP_ROOT/compose.dev.yml"
readonly LIMITS_ENV="$APP_ROOT/dev-limits.env"
readonly CONFIG_DIR=/etc/ageniza-dev
readonly DEPLOY_CONFIG="$CONFIG_DIR/dev-deploy.env"
readonly RUNTIME_ENV="$CONFIG_DIR/runtime.env"
readonly MIGRATIONS_ENV="$CONFIG_DIR/migrations.env"
readonly POSTGRES_ENV="$CONFIG_DIR/postgres.env"
readonly GITHUB_TOKEN_FILE="$CONFIG_DIR/github-token"
readonly REGISTRY_CONFIG="$CONFIG_DIR/registry"
readonly RELEASE_DIR=/var/lib/ageniza-dev/releases
readonly LOCK_FILE=/run/lock/ageniza-deploy-dev.lock
readonly GITHUB_API=https://api.github.com
readonly RELEASE_WORKFLOW=.github/workflows/dev.yml
readonly RELEASE_BRANCH=develop
readonly MANIFEST_ARTIFACT=dev-release-manifest
readonly DEV_DOMAIN=dev.ageniza.com.br

WORK_DIR=''
RESTORE_ARMED=false
REPOSITORY='' IMAGE_NAMESPACE=''
RELEASE='' RUN_ID='' RUNTIME_SNAPSHOT=''
API_IMAGE='' WEB_IMAGE='' WORKER_IMAGE='' MIGRATIONS_IMAGE=''

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'ageniza-deploy-dev: %s\n' "$*"; }
require_root() { [[ $EUID -eq 0 ]] || die 'must run as root via the fixed sudo rule'; }
valid_release() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
valid_run_id() { [[ "$1" =~ ^[1-9][0-9]{0,19}$ ]]; }

usage() {
  cat <<'USAGE'
Usage:
  ageniza-deploy-dev apply-dev <40-hex-commit-sha> <github-run-id>
  ageniza-deploy-dev status-dev

apply-dev deploys only the dev-release-manifest artifact of a push-to-develop run of
.github/workflows/dev.yml for a commit that is on develop.
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
  require_root_file "$LIMITS_ENV" '600|640|644'
  REPOSITORY="$(config_value AGENIZA_REPOSITORY)"
  IMAGE_NAMESPACE="$(config_value AGENIZA_IMAGE_NAMESPACE)"
  AGENIZA_POSTGRES_IMAGE="$(config_value AGENIZA_POSTGRES_IMAGE)"
  AGENIZA_MAILPIT_IMAGE="$(config_value AGENIZA_MAILPIT_IMAGE)"
  [[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'AGENIZA_REPOSITORY must be <owner>/<name>'
  [[ "$IMAGE_NAMESPACE" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*$ ]] || die 'AGENIZA_IMAGE_NAMESPACE must be ghcr.io/<lowercase-owner>'
  [[ "$AGENIZA_POSTGRES_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]] || die 'AGENIZA_POSTGRES_IMAGE must be pinned by a sha256 digest'
  [[ "$AGENIZA_MAILPIT_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]] || die 'AGENIZA_MAILPIT_IMAGE must be pinned by a sha256 digest'
  export AGENIZA_POSTGRES_IMAGE AGENIZA_MAILPIT_IMAGE
  export AGENIZA_POSTGRES_ENV_FILE="$POSTGRES_ENV"
}

# Application images must come from this repository's own GHCR namespace, pinned by digest.
valid_app_image() {
  local prefix="$IMAGE_NAMESPACE/ageniza-$1@sha256:"
  [[ "$2" == "$prefix"* && "${2#"$prefix"}" =~ ^[a-f0-9]{64}$ ]]
}

# Whatever the file says, mail never leaves the environment: SMTP_URL, EMAIL_FROM and the trusted proxy network are
# fixed by compose.dev.yml, so the file may not even name them. Payments stay simulated, and the object storage must be
# dev buckets, so a copy of the production file cannot be applied here by mistake.
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
      SMTP_URL|EMAIL_FROM|DEPLOY_TARGET|API_TRUSTED_PROXY_CIDRS) die "$key is fixed by compose.dev.yml and must not appear in $RUNTIME_ENV" ;;
      APP_ENV) [[ "$value" == production ]] || die 'APP_ENV must be production' ;;
      PAYMENTS_PROVIDER) [[ "$value" == simulado ]] || die 'PAYMENTS_PROVIDER must be simulado in dev' ;;
      PAYMENTS_SIMULATED_RENEWAL) [[ "$value" == approved || "$value" == declined ]] || die 'PAYMENTS_SIMULATED_RENEWAL must be approved or declined' ;;
      WORKER_SMOKE_JOB) [[ "$value" == false ]] || die 'WORKER_SMOKE_JOB must be false' ;;
      WORKER_CONCURRENCY) [[ "$value" =~ ^[1-2]$ ]] || die 'WORKER_CONCURRENCY must be 1 or 2 in dev' ;;
      AUTH_TERMS_VERSION|AUTH_PRIVACY_VERSION) [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "$key must use YYYY-MM-DD" ;;
      APP_PUBLIC_URL) [[ "$value" == "https://$DEV_DOMAIN" ]] || die "APP_PUBLIC_URL must be https://$DEV_DOMAIN" ;;
      API_CORS_ORIGINS) [[ "$value" == "https://$DEV_DOMAIN" ]] || die "API_CORS_ORIGINS must be https://$DEV_DOMAIN" ;;
      BETTER_AUTH_SECRET|DATABASE_URL) [[ -n "$value" ]] || die "$key must not be blank" ;;
      R2_ENDPOINT|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|IDENTITY_STORAGE_ENDPOINT|IDENTITY_STORAGE_ACCESS_KEY_ID|IDENTITY_STORAGE_SECRET_ACCESS_KEY) [[ -n "$value" ]] || die "$key must not be blank" ;;
      R2_BUCKET|IDENTITY_STORAGE_BUCKET) [[ "$value" =~ ^[a-z0-9-]*dev[a-z0-9-]*$ ]] || die "$key must name a dev bucket (the name must contain \"dev\")" ;;
      R2_REGION|IDENTITY_STORAGE_REGION) ;;
      R2_FORCE_PATH_STYLE|IDENTITY_STORAGE_FORCE_PATH_STYLE) [[ "$value" == true || "$value" == false ]] || die "$key must be true or false" ;;
      MEDIA_UPLOAD_URL_EXPIRY_SECONDS|MEDIA_DOWNLOAD_URL_EXPIRY_SECONDS|MEDIA_MULTIPART_THRESHOLD_BYTES|MEDIA_MULTIPART_PART_BYTES|MEDIA_MAX_BYTES_IMAGE|MEDIA_MAX_BYTES_VIDEO|STORAGE_QUOTA_DEFAULT_BYTES|STORAGE_QUOTA_DEFAULT_OBJECT_COUNT) [[ "$value" =~ ^[0-9]+$ ]] || die "$key must be a positive integer" ;;
      MEDIA_PROCESSING_TIMEOUT_SECONDS|MEDIA_PROCESSING_MAX_DURATION_SECONDS|MEDIA_THUMBNAIL_WIDTH_PIXELS|MEDIA_PREVIEW_MAX_HEIGHT_PIXELS|MEDIA_PREVIEW_MAX_OUTPUT_BYTES) [[ "$value" =~ ^[0-9]+$ ]] || die "$key must be a positive integer" ;;
      IDENTITY_DOWNLOAD_URL_EXPIRY_SECONDS|IDENTITY_MAX_IMAGE_BYTES) [[ "$value" =~ ^[0-9]+$ ]] || die "$key must be a positive integer" ;;
      SENTRY_DSN|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_CALLBACK_URL|API_PUBLIC_URL|SUPPORT_CONTACT_EMAIL) ;;
      *) die "$RUNTIME_ENV contains a key that is not allowed: $key" ;;
    esac
  done < "$RUNTIME_ENV"
  for required in APP_ENV BETTER_AUTH_SECRET APP_PUBLIC_URL AUTH_TERMS_VERSION AUTH_PRIVACY_VERSION DATABASE_URL API_CORS_ORIGINS PAYMENTS_PROVIDER WORKER_SMOKE_JOB R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET IDENTITY_STORAGE_ENDPOINT IDENTITY_STORAGE_ACCESS_KEY_ID IDENTITY_STORAGE_SECRET_ACCESS_KEY IDENTITY_STORAGE_BUCKET; do
    [[ -n "${seen[$required]+x}" ]] || die "$RUNTIME_ENV is missing $required"
  done
  [[ "$(read_value "$RUNTIME_ENV" R2_BUCKET)" != "$(read_value "$RUNTIME_ENV" IDENTITY_STORAGE_BUCKET)" ]] || die 'IDENTITY_STORAGE_BUCKET must differ from R2_BUCKET'
  [[ "$(read_value "$RUNTIME_ENV" R2_ACCESS_KEY_ID)" != "$(read_value "$RUNTIME_ENV" IDENTITY_STORAGE_ACCESS_KEY_ID)" ]] || die 'IDENTITY_STORAGE_ACCESS_KEY_ID must differ from R2_ACCESS_KEY_ID'
}

prepare_github_access() {
  local token
  require_root_file "$GITHUB_TOKEN_FILE" '600'
  WORK_DIR="$(mktemp -d /run/ageniza-deploy-dev.XXXXXX)"
  token="$(tr -d '[:space:]' < "$GITHUB_TOKEN_FILE")"
  [[ -n "$token" ]] || die "$GITHUB_TOKEN_FILE is empty"
  # Headers go through a 0600 file so the token never appears in the process list.
  printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: ageniza-deploy-dev\n' "$token" > "$WORK_DIR/github-headers"
}

github_api() {
  # curl does not forward the Authorization header when an artifact download redirects to storage.
  curl --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-time 60 --location \
    --header @"$WORK_DIR/github-headers" --output "$2" "$1"
}

fetch_verified_release() {
  local sha="$1" run_id="$2" repository_lower="${REPOSITORY,,}" compare_status url
  github_api "$GITHUB_API/repos/$REPOSITORY/actions/runs/$run_id" "$WORK_DIR/run.json" || die "cannot read workflow run $run_id from GitHub"
  jq -e --arg sha "$sha" --arg repo "$repository_lower" --arg workflow "$RELEASE_WORKFLOW" --arg branch "$RELEASE_BRANCH" '
    .head_sha == $sha and .head_branch == $branch and .event == "push"
    and ((.path // "") | split("@")[0]) == $workflow
    and ((.repository.full_name // "") | ascii_downcase) == $repo
    and ((.head_repository.full_name // "") | ascii_downcase) == $repo' "$WORK_DIR/run.json" >/dev/null \
    || die "run $run_id is not a push-to-$RELEASE_BRANCH run of $RELEASE_WORKFLOW for $sha"

  github_api "$GITHUB_API/repos/$REPOSITORY/compare/$sha...$RELEASE_BRANCH" "$WORK_DIR/compare.json" || die "cannot compare $sha with $RELEASE_BRANCH"
  compare_status="$(jq -r '.status' "$WORK_DIR/compare.json")"
  [[ "$compare_status" == identical || "$compare_status" == ahead ]] || die "release $sha is not on $RELEASE_BRANCH (compare status: $compare_status)"

  github_api "$GITHUB_API/repos/$REPOSITORY/actions/runs/$run_id/artifacts?name=$MANIFEST_ARTIFACT" "$WORK_DIR/artifacts.json" || die 'cannot list release artifacts'
  url="$(jq -r --arg name "$MANIFEST_ARTIFACT" '[.artifacts[] | select(.name == $name and (.expired | not))][0].archive_download_url // ""' "$WORK_DIR/artifacts.json")"
  [[ "${url,,}" == "$GITHUB_API/repos/$repository_lower/actions/artifacts/"* ]] || die "run $run_id has no $MANIFEST_ARTIFACT artifact"
  github_api "$url" "$WORK_DIR/release.zip" || die 'cannot download the release manifest'
  unzip -p "$WORK_DIR/release.zip" release.env > "$WORK_DIR/release.env" || die 'release manifest archive is invalid'

  [[ "$(read_value "$WORK_DIR/release.env" TARGET || true)" == dev ]] || die 'release manifest is not a dev manifest'
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
    docker compose -p "$APP_PROJECT" --env-file "$LIMITS_ENV" -f "$APP_COMPOSE" -f "$DEV_COMPOSE" "$@"
}

# Replaces api, web, worker and the mail sink with the loaded release and waits for private health.
# --no-deps keeps application releases from recreating the database container.
start_release() {
  compose_app up -d --pull never --no-deps --wait --wait-timeout 180 mailpit api web worker
  compose_app exec -T api node -e "fetch('http://127.0.0.1:3001/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  compose_app exec -T web wget -q -O /dev/null http://127.0.0.1:8080/health
  compose_app exec -T worker node -e "fetch('http://127.0.0.1:3002/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

# The migration job counts against the same budget as the stack (infra/vps/dev-limits.env).
run_migrations() {
  local cpus mem pids
  cpus="$(read_value "$LIMITS_ENV" DEV_MIGRATIONS_CPUS || true)"
  mem="$(read_value "$LIMITS_ENV" DEV_MIGRATIONS_MEM || true)"
  pids="$(read_value "$LIMITS_ENV" DEV_MIGRATIONS_PIDS || true)"
  [[ "$cpus" =~ ^[0-9]+(\.[0-9]+)?$ && "$mem" =~ ^[0-9]+[mg]$ && "$pids" =~ ^[0-9]+$ ]] || die "$LIMITS_ENV must set DEV_MIGRATIONS_CPUS, DEV_MIGRATIONS_MEM and DEV_MIGRATIONS_PIDS"
  docker run --rm --pull never --network "${APP_PROJECT}_dev-private" --env-file "$MIGRATIONS_ENV" \
    --cpus "$cpus" --memory "$mem" --memory-swap "$mem" --pids-limit "$pids" "$MIGRATIONS_IMAGE"
}

load_manifest() {
  local file="$1"
  RELEASE="$(read_value "$file" RELEASE || true)"
  RUN_ID="$(read_value "$file" RUN_ID || true)"
  API_IMAGE="$(read_value "$file" API_IMAGE || true)"
  WEB_IMAGE="$(read_value "$file" WEB_IMAGE || true)"
  WORKER_IMAGE="$(read_value "$file" WORKER_IMAGE || true)"
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
  install -o root -g root -m 0600 "$temporary" "$RELEASE_DIR/current.env"
  rm -f -- "$temporary"
}

# Only the live release keeps its runtime.env snapshot; dev has no manual rollback to feed.
prune_runtime_snapshots() {
  local keep file
  keep="$(read_value "$RELEASE_DIR/current.env" RUNTIME_ENV_FILE || true)"
  for file in "$RELEASE_DIR"/*.env; do
    [[ "$file" == */current.env ]] && continue
    [[ -f "$file" ]] || continue
    [[ "$file" == "$keep" ]] || rm -f -- "$file"
  done
}

restore_live_release() {
  if ! load_manifest "$RELEASE_DIR/current.env"; then
    note 'apply failed and there is no valid live release to restore'
    return 0
  fi
  note "apply failed; restarting live release $RELEASE"
  start_release || note 'restore failed; inspect the host (docker compose -p ageniza-dev ps)'
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

apply_dev() {
  local sha="$1" run_id="$2" image
  load_deploy_config
  if [[ "$(read_value "$RELEASE_DIR/current.env" RELEASE || true)" == "$sha" ]]; then
    note "release $sha is already active"
    return 0
  fi
  validate_runtime_env
  require_root_file "$MIGRATIONS_ENV" '600'
  require_root_file "$POSTGRES_ENV" '600'
  [[ -n "$(read_value "$MIGRATIONS_ENV" MIGRATION_DATABASE_URL || true)" ]] || die "$MIGRATIONS_ENV must set MIGRATION_DATABASE_URL"

  prepare_github_access
  fetch_verified_release "$sha" "$run_id"
  # start_release runs with --pull never, so the sink image is pulled here with the application images.
  for image in "$API_IMAGE" "$WEB_IMAGE" "$WORKER_IMAGE" "$MIGRATIONS_IMAGE" "$AGENIZA_MAILPIT_IMAGE"; do pull_verified_image "$image"; done

  RELEASE="$sha"; RUN_ID="$run_id"; RUNTIME_SNAPSHOT="$RELEASE_DIR/$sha.env"
  install -o root -g root -m 0600 "$RUNTIME_ENV" "$RUNTIME_SNAPSHOT"

  # Starts the database on first use; a changed AGENIZA_POSTGRES_IMAGE digest restarts it briefly.
  compose_app up -d --wait --wait-timeout 180 postgres || die 'PostgreSQL did not become healthy; the live release was not changed'

  note "applying forward-only migrations for $sha"
  run_migrations || die 'migrations failed; the live release was not changed'

  RESTORE_ARMED=true
  note "replacing containers with release $sha"
  start_release
  write_current_manifest
  RESTORE_ARMED=false
  prune_runtime_snapshots
  note "release $sha is active"
}

print_status() {
  local release
  release="$(read_value "$RELEASE_DIR/current.env" RELEASE || true)"
  printf 'RELEASE=%s\n' "${release:-none}"
}

take_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || die 'another dev deployment holds the host lock'
}

main() {
  require_root
  install -d -o root -g root -m 0700 "$RELEASE_DIR"
  trap on_exit EXIT
  case "${1:-}" in
    status-dev)
      [[ $# -eq 1 ]] || die 'status-dev accepts no arguments'
      print_status
      return
      ;;
    apply-dev)
      [[ -f "$APP_COMPOSE" && -f "$DEV_COMPOSE" && -f "$LIMITS_ENV" ]] || die 'deployment bundle is incomplete; re-run install-dev-deploy.sh'
      ;;
    -h|--help|'') usage; return ;;
    *) die 'unknown command' ;;
  esac
  take_lock
  [[ $# -eq 3 ]] || die 'usage: ageniza-deploy-dev apply-dev <40-hex-commit-sha> <github-run-id>'
  valid_release "$2" || die 'release must be a 40-character lowercase commit SHA'
  valid_run_id "$3" || die 'run ID must be a positive integer'
  apply_dev "$2" "$3"
}

main "$@"
