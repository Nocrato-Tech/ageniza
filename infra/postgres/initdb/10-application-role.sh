#!/bin/sh
# Runs once, when the PostgreSQL data volume is first initialised (local, CI, and production).
# Creates the application login role; migrations grant it privileges. The role is never a
# superuser and never bypasses RLS (ADR 0011).
set -eu
: "${AGENIZA_APP_DB_PASSWORD:?AGENIZA_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$AGENIZA_APP_DB_PASSWORD" <<'SQL'
create role ageniza_app login password :'app_password'
  nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
SQL
