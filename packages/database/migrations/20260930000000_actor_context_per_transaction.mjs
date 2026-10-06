/**
 * Issue #166. Structural change registered in decisions.md (2026-09-30, "O ator de cada transação é
 * gravado uma vez pelo banco, e não pelo GUC `app.user_id`"): the transaction actor stops living in
 * a connection setting the runtime role can rewrite mid-statement and becomes a row the database
 * writes exactly once per transaction.
 *
 * Before this migration every policy and every `security definer` authorization helper read
 * `app_private.current_user_id()`, which was `current_setting('app.user_id')`. `set_config` is
 * PUBLIC, so `ageniza_app` could forge that value in the middle of an instruction (inside a SET
 * subquery, for example) and every check answered as the forged user -- the account-manager
 * escalation proven in the PR #159 re-review.
 *
 * The actor now lives in `app_private.actor_context`, one row per transaction, keyed by the
 * transaction's own `xid8` (global and never reused, so one transaction never sees another's actor,
 * even on a pooled connection). `ageniza_app` has no privilege at all on the table; its only door is
 * `app_private.bind_actor`, which writes once and refuses a second write with 42501. The GUC remains
 * writable but nothing reads it, so forging it has no effect. The table is unlogged: the actor only
 * matters inside a live transaction, so WAL and replicas are not needed for it.
 */
export async function up(knex) {
  await knex.raw(`
    create unlogged table app_private.actor_context (
      xact_id xid8 primary key,
      user_id uuid not null,
      bound_at timestamptz not null default now()
    );
    create index actor_context_bound_at_idx on app_private.actor_context (bound_at);

    -- The runtime role gets no privilege on the table: not select, insert, update or delete. Its
    -- only way in is app_private.bind_actor below, which owns the write and accepts it once.
    revoke all on app_private.actor_context from public;
  `);

  await knex.raw(`
    -- Grava o ator da transação corrente uma única vez. A chave primária sobre o xid8 da transação
    -- é a trava: uma segunda chamada colide e é recusada com 42501, então não existe troca de ator
    -- dentro de uma transação, nem para o mesmo usuário.
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
    -- Same name and signature as the applied foundation migration, so every policy and every
    -- function that calls it keeps working. It reads the actor bound for the current transaction;
    -- with no bind it returns null, exactly like the missing GUC before, and RLS shows no tenant
    -- rows. The GUC is never read again.
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
    -- O xid8 nunca se repete, então a linha de uma transação encerrada não é perigosa, só ocupa
    -- espaço. O worker chama esta função de tempos em tempos para apagar o que passou de uma hora.
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
