/**
 * Issue #166, decision 2026-09-30 (the transaction actor is bound once by the database, not by the
 * app.user_id GUC). The GUC was forgeable by ageniza_app mid-statement, which is the escalation proven
 * in the PR #159 re-review. The actor now lives in app_private.actor_context, one row per transaction,
 * keyed by the transaction's xid8, which is never reused.
 */
export async function up(knex) {
  await knex.raw(`
    create unlogged table app_private.actor_context (
      xact_id xid8 primary key,
      user_id uuid not null,
      bound_at timestamptz not null default now()
    );
    create index actor_context_bound_at_idx on app_private.actor_context (bound_at);

    -- ageniza_app gets no privilege on the table; app_private.bind_actor is its only way in.
    revoke all on app_private.actor_context from public;
  `);

  await knex.raw(`
    -- The primary key on the transaction's xid8 is the lock: a second bind fails with 42501.
    create function app_private.bind_actor(p_user_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if p_user_id is null then
        raise exception using
          errcode = '42501',
          message = 'actor user id is required';
      end if;

      insert into app_private.actor_context (xact_id, user_id)
      values (pg_catalog.pg_current_xact_id(), p_user_id);
    exception
      when unique_violation then
        raise exception using
          errcode = '42501',
          message = 'actor already bound for this transaction';
    end;
    $function$;
    revoke all on function app_private.bind_actor(uuid) from public;
    grant execute on function app_private.bind_actor(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- Same signature as the foundation migration, so policies keep working. Null when unbound
    -- (RLS then shows no rows). The GUC is never read.
    create or replace function app_private.current_user_id() returns uuid
      language sql
      stable
      security definer
      set search_path = ''
      as $$
        select actor.user_id
        from app_private.actor_context actor
        where actor.xact_id = pg_catalog.pg_current_xact_id_if_assigned()
      $$;
    revoke all on function app_private.current_user_id() from public;
    grant execute on function app_private.current_user_id() to ageniza_app;
  `);

  await knex.raw(`
    -- xid8 is never reused, so old rows are harmless; the worker purges them hourly.
    create function app_private.purge_actor_context()
    returns integer
    language sql
    security definer
    set search_path = ''
    as $$
      with deleted as (
        delete from app_private.actor_context
        where bound_at < now() - interval '1 hour'
        returning 1
      )
      select count(*)::integer from deleted
    $$;
    revoke all on function app_private.purge_actor_context() from public;
    grant execute on function app_private.purge_actor_context() to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
