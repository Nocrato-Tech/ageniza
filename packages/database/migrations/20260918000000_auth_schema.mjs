// Better Auth 1.7.5 schema, generated once with getMigrations(authOptions) and
// compileMigrations() against an empty PostgreSQL database. The SQL is frozen so
// upgrading Better Auth cannot silently rewrite an applied migration.
export const betterAuthVersion = '1.7.5';

export const authConstructionSql = String.raw`create schema if not exists "auth";

create table "auth"."user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth"."session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "auth"."user" ("id") on delete cascade);

create table "auth"."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "auth"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "auth"."verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index "session_userId_idx" on "auth"."session" ("userId");

create index "account_userId_idx" on "auth"."account" ("userId");

create index "verification_identifier_idx" on "auth"."verification" ("identifier");`;

export async function up(knex) {
  await knex.raw('create schema if not exists auth');
  await knex.raw(authConstructionSql);
  await knex.raw(`
    alter table auth."user"
      add constraint user_email_normalized
      check ("email" = lower(btrim("email")));

    revoke all on schema auth from public;
    grant usage on schema auth to ageniza_app;
    grant select, insert, update, delete on all tables in schema auth to ageniza_app;
    alter default privileges in schema auth
      grant select, insert, update, delete on tables to ageniza_app;

    create schema if not exists audit;
    revoke all on schema audit from public;
    create table audit.events (
      id bigint generated always as identity primary key,
      occurred_at timestamptz not null default now(),
      action text not null,
      actor_user_id uuid null,
      agency_id uuid null,
      target_type text null,
      target_id uuid null,
      request_id text null
    );
    revoke all on audit.events from public;
    grant usage on schema audit to ageniza_app;
    grant insert on audit.events to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
