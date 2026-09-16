-- Server-only namespace for future security-definer helpers and internal database primitives.
-- Product tables, domain policies, and tenant membership rules belong to later append-only migrations.

create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated;

alter default privileges in schema app_private
  revoke all on tables from public, anon, authenticated;

alter default privileges in schema app_private
  revoke all on sequences from public, anon, authenticated;

alter default privileges in schema app_private
  revoke all on functions from public, anon, authenticated;

comment on schema app_private is
  'Server-only database primitives. Never expose this schema through the Supabase Data API.';
