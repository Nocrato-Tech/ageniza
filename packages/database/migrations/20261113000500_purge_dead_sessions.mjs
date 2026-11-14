// Retention of the sessions that died more than 30 days ago (decision 2026-11-12). Forward-only, and a new migration.
//
// Recorded in docs/business/decisions/2026-11-12-sessoes-vencidas-ha-mais-de-30-dias-sao-apagadas.md.
//
// `auth."session"` keeps the IP, the user agent and the city of a session. A session that is ended on purpose (logout, logout-all,
// "sign out of the others", a reset, a removal) is already deleted, but one that only expired stays until the person uses that
// cookie again, which may be never; and one the guard refuses since the credential was replaced (#719) can survive the reset.
//
// `app_private.purge_dead_sessions(p_at, p_limit)` deletes, at most `p_limit` rows per call, the sessions that have been dead for
// more than `dead_session_retention()` (30 days) at `p_at`: the row is deleted, not blanked. A session is dead since the earlier of
// its `expiresAt` and, when it was made at or before the last replacement of the credential (the rule of `ACTIVE_SESSION_SQL`, in
// apps/api/src/modules/auth/session-validity.ts), that replacement. A session that is still active is never a candidate.
//
// - `security definer`, as the sibling `purge_unconfirmed_accounts`: the helpers it uses (`require_read_committed`,
//   `current_user_id`) are closed to `ageniza_app`, which only needs EXECUTE on this function. It deletes only rows of
//   `auth."session"`, which the role could already delete (`auth."session"` has no RLS), so it widens nothing and needs no bypass.
//   Closed to PUBLIC, open to `ageniza_app`, and refused when a user is bound to the transaction, as every request binds one and
//   the worker never does.
// - `for update skip locked` before the delete: a session being renewed or revoked at that moment is skipped, and the lock waits
//   for nothing, so the call never blocks the table. The conditions are checked again on a row that changed under the lock.
// - The instant is a parameter so that the tests do not depend on the clock, never to look ahead: refused past now() plus a minute.

export async function up(knex) {
  await knex.raw(`
    create function app_private.dead_session_retention()
    returns interval
    language sql
    immutable
    set search_path = ''
    as $function$
      select interval '30 days'
    $function$;
    revoke all on function app_private.dead_session_retention() from public;

    create function app_private.purge_dead_sessions(p_at timestamptz, p_limit integer)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_cutoff timestamptz;
      v_deleted integer;
    begin
      perform app_private.require_read_committed();
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The dead sessions are purged by the worker, not by a request.';
      end if;
      if p_at is null then
        raise exception using errcode = '22023', message = 'The purge needs the instant it is run at.';
      end if;
      if p_at > pg_catalog.now() + interval '1 minute' then
        raise exception using errcode = '22023', message = 'The purge cannot be run at an instant in the future.';
      end if;
      if p_limit is null or p_limit < 1 or p_limit > 1000 then
        raise exception using errcode = '22023', message = 'The batch is between 1 and 1000 sessions.';
      end if;

      v_cutoff := p_at - app_private.dead_session_retention();

      with doomed as (
        select dead.id
        from auth."session" dead
        where dead."expiresAt" < v_cutoff
          or (
            dead."createdAt" < v_cutoff
            and exists (
              select 1
              from (
                select greatest(
                  coalesce((select person."passwordChangedAt" from auth."user" person where person.id = dead."userId"), '-infinity'::timestamptz),
                  coalesce((select max(credential."passwordChangedAt") from auth."account" credential where credential."userId" = dead."userId"), '-infinity'::timestamptz)
                ) as changed_at
              ) replaced
              where dead."createdAt" <= replaced.changed_at and replaced.changed_at < v_cutoff
            )
          )
        order by dead."expiresAt", dead.id
        limit p_limit
        for update of dead skip locked
      )
      delete from auth."session" gone using doomed where gone.id = doomed.id;

      get diagnostics v_deleted = row_count;
      return v_deleted;
    end;
    $function$;
    revoke all on function app_private.purge_dead_sessions(timestamptz, integer) from public;
    grant execute on function app_private.purge_dead_sessions(timestamptz, integer) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
