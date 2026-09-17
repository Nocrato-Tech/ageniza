#!/usr/bin/env bash
# Encrypted off-host PostgreSQL backup and restore rehearsal (issue #18).
# Install as /usr/local/sbin/ageniza-backup. Credentials live only in /etc/ageniza/backup.env.
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly APP_PROJECT=ageniza
readonly APP_ROOT=/opt/ageniza
readonly APP_COMPOSE="$APP_ROOT/compose.yml"
readonly PRODUCTION_COMPOSE="$APP_ROOT/compose.production.yml"
readonly CONFIG_DIR=/etc/ageniza
readonly DEPLOY_CONFIG="$CONFIG_DIR/deploy.env"
readonly BACKUP_CONFIG="$CONFIG_DIR/backup.env"
readonly PASSPHRASE_FILE="$CONFIG_DIR/backup-passphrase"
readonly SPOOL_DIR=/var/lib/ageniza/backups
readonly TMP_DIR="$SPOOL_DIR/tmp"
readonly LOCK_FILE=/run/lock/ageniza-backup.lock

WORK_DIR=''
RESTORE_CONTAINER=''
RESTORE_NETWORK=''

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'ageniza-backup: %s\n' "$*"; }
require_root() { [[ $EUID -eq 0 ]] || die 'must run as root'; }

usage() {
  cat <<'USAGE'
Usage:
  ageniza-backup backup           Dump, encrypt, and upload the database to R2
  ageniza-backup verify-restore   Restore the newest local dump into a throwaway container

Retention is a Cloudflare R2 lifecycle rule; see docs/infra/backup-restore.md.
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

backup_value() { read_value "$BACKUP_CONFIG" "$1" || die "missing $1 in $BACKUP_CONFIG"; }

# Only the passphrase is needed to decrypt and rehearse a restore. Keep this independent of
# load_r2_configuration so verify-restore still works with backup.env missing or incomplete
# (rotated token, freshly rebuilt host, etc.) -- exactly when a rehearsal is most needed.
require_passphrase() {
  require_root_file "$PASSPHRASE_FILE" '600'
}

load_r2_configuration() {
  require_root_file "$BACKUP_CONFIG" '600'
  R2_ACCOUNT_ID="$(backup_value R2_ACCOUNT_ID)"
  R2_BUCKET="$(backup_value R2_BUCKET)"
  R2_ACCESS_KEY_ID="$(backup_value R2_ACCESS_KEY_ID)"
  R2_SECRET_ACCESS_KEY="$(backup_value R2_SECRET_ACCESS_KEY)"
  # Optional: a scheduled ping URL (for example healthchecks.io) that alerts when a run is missed.
  HEARTBEAT_URL="$(read_value "$BACKUP_CONFIG" HEARTBEAT_URL || true)"
  [[ "$R2_ACCOUNT_ID" =~ ^[a-f0-9]{16,64}$ ]] || die 'R2_ACCOUNT_ID is invalid'
  [[ "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,62}$ ]] || die 'R2_BUCKET is invalid'
  [[ -n "$R2_ACCESS_KEY_ID" && -n "$R2_SECRET_ACCESS_KEY" ]] || die 'R2 credentials must not be blank'
}

# WORK_DIR must be real disk, not tmpfs: the VPS's /run is sized for a fraction of memory, and a
# growing plaintext dump (or its decrypted rehearsal copy) has no business filling RAM.
ensure_work_dir() {
  install -d -o root -g root -m 0700 "$TMP_DIR"
  WORK_DIR="$(mktemp -d "$TMP_DIR/ageniza-backup.XXXXXX")"
}

postgres_image() { read_value "$DEPLOY_CONFIG" AGENIZA_POSTGRES_IMAGE || die "missing AGENIZA_POSTGRES_IMAGE in $DEPLOY_CONFIG"; }

compose_database() {
  # Only the database service is addressed; image and env file come from the deploy configuration.
  AGENIZA_POSTGRES_IMAGE="$(postgres_image)" \
  AGENIZA_POSTGRES_ENV_FILE="$CONFIG_DIR/postgres.env" \
  AGENIZA_RUNTIME_ENV_FILE="$CONFIG_DIR/runtime.env" \
  AGENIZA_API_IMAGE=placeholder AGENIZA_WEB_IMAGE=placeholder AGENIZA_WORKER_IMAGE=placeholder \
    docker compose -p "$APP_PROJECT" -f "$APP_COMPOSE" -f "$PRODUCTION_COMPOSE" "$@"
}

take_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || die 'another backup or restore rehearsal is running'
}

cleanup() {
  local status=$?
  [[ -n "$WORK_DIR" ]] && rm -rf -- "$WORK_DIR"
  exit "$status"
}

restore_cleanup() {
  # $? is captured first: the teardown below is deliberately `|| true` and must not overwrite
  # the real exit status of whatever failed (or succeeded) in verify_restore.
  local status=$?
  [[ -n "$RESTORE_CONTAINER" ]] && { docker rm --force --volumes "$RESTORE_CONTAINER" >/dev/null 2>&1 || true; }
  [[ -n "$RESTORE_NETWORK" ]] && { docker network rm "$RESTORE_NETWORK" >/dev/null 2>&1 || true; }
  [[ -n "$WORK_DIR" ]] && rm -rf -- "$WORK_DIR"
  exit "$status"
}

backup() {
  local stamp object dump encrypted checksum curl_config
  require_passphrase
  load_r2_configuration
  install -d -o root -g root -m 0700 "$SPOOL_DIR"
  ensure_work_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  object="ageniza/$(date -u +%Y/%m)/ageniza-$stamp.dump.gpg"
  dump="$WORK_DIR/ageniza-$stamp.dump"
  encrypted="$SPOOL_DIR/ageniza-$stamp.dump.gpg"

  note 'creating the database dump'
  # The socket inside the container authenticates as the postgres superuser; no password is handled here.
  compose_database exec -T --user postgres postgres pg_dump --format=custom --dbname=ageniza > "$dump"
  [[ -s "$dump" ]] || die 'pg_dump produced an empty file'

  note 'encrypting the dump'
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSPHRASE_FILE" \
    --output "$encrypted" "$dump"
  chmod 0600 "$encrypted"
  checksum="$(sha256sum "$encrypted" | cut -d' ' -f1)"

  note "uploading $object"
  curl_config="$WORK_DIR/curl.conf"
  # Credentials go through a 0600 config file so they never appear in the process list.
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:auto:s3"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" > "$curl_config"
  curl --config "$curl_config" --fail --silent --show-error --proto '=https' --retry 3 --retry-all-errors \
    --max-time 1800 --upload-file "$encrypted" \
    "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET/$object" >/dev/null \
    || die 'upload to R2 failed'

  # Keep only the newest local copy; R2 lifecycle rules own long-term retention.
  find "$SPOOL_DIR" -maxdepth 1 -name 'ageniza-*.dump.gpg' ! -name "$(basename "$encrypted")" -delete
  note "uploaded $object (sha256 $checksum)"

  if [[ -n "${HEARTBEAT_URL:-}" ]]; then
    curl --fail --silent --show-error --proto '=https' --max-time 30 "$HEARTBEAT_URL" >/dev/null \
      || note 'heartbeat ping failed; the backup itself succeeded'
  fi
}

verify_restore() {
  local latest image container network decrypted tables
  require_passphrase
  latest="$(find "$SPOOL_DIR" -maxdepth 1 -name 'ageniza-*.dump.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "$latest" ]] || die "no local dump in $SPOOL_DIR; run a backup or download one from R2 first"
  image="$(postgres_image)"

  ensure_work_dir
  decrypted="$WORK_DIR/restore.dump"
  container="ageniza-restore-rehearsal-$$"
  network="ageniza-restore-rehearsal-$$"
  RESTORE_CONTAINER="$container"
  RESTORE_NETWORK="$network"

  # Install the cleanup trap before creating anything docker-side: a failure in the very next
  # command (network create, then docker run) must not leave a network or container orphaned.
  trap restore_cleanup EXIT

  note "decrypting $latest"
  gpg --batch --yes --decrypt --passphrase-file "$PASSPHRASE_FILE" --output "$decrypted" "$latest"

  note 'starting a throwaway database'
  docker network create --internal "$network" >/dev/null
  # The rehearsal database is isolated, disposable, and never reachable from the application.
  docker run --detach --name "$container" --network "$network" --user postgres \
    --env POSTGRES_PASSWORD=rehearsal --env POSTGRES_DB=ageniza \
    --env AGENIZA_APP_DB_PASSWORD=rehearsal \
    --volume "$APP_ROOT/postgres/initdb:/docker-entrypoint-initdb.d:ro" \
    "$image" >/dev/null

  local attempt=0
  until docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d ageniza >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    (( attempt <= 60 )) || die 'the rehearsal database did not become ready'
    sleep 2
  done

  note 'restoring the dump'
  docker exec -i "$container" pg_restore --username=postgres --dbname=ageniza --no-owner < "$decrypted"

  tables="$(docker exec "$container" psql --username=postgres --dbname=ageniza --tuples-only --no-align \
    --command="select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')")"
  [[ "$tables" =~ ^[0-9]+$ ]] || die 'could not determine the restored table count'
  # A dump that is empty or schema-only must fail the rehearsal, not merely report zero.
  (( tables > 0 )) || die 'restore rehearsal failed: the restored database has zero application tables'
  docker exec "$container" psql --username=postgres --dbname=ageniza --tuples-only --no-align \
    --command="select app_private.current_user_id() is null" | grep -qx t \
    || die 'the restored database is missing app_private.current_user_id()'
  note "restore rehearsal succeeded: $tables tables restored from $(basename "$latest")"
}

main() {
  require_root
  trap cleanup EXIT
  case "${1:-}" in
    backup) [[ $# -eq 1 ]] || die 'backup accepts no arguments'; take_lock; backup ;;
    verify-restore) [[ $# -eq 1 ]] || die 'verify-restore accepts no arguments'; take_lock; verify_restore ;;
    -h|--help|'') usage ;;
    *) die 'unknown command' ;;
  esac
}

main "$@"
