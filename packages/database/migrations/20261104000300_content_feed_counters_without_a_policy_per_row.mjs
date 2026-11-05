// Decision: docs/business/decisions/2026-11-04-o-celular-do-calendario-mostra-o-feed-inteiro-do-cliente.md. Forward-only.
//
// The counters of the phone of the calendar (posts, approved, awaiting approval) count the feed of a client, and they were a
// `count(*)` under the policy of `contents`, `contents_select`, which calls `has_agency_permission(client_agency_id(client_id), ...)`
// for every row it reads: 2.5 to 3.8 s over 40 000 contents, against 21 ms for the same count without the policy. The API pool has
// four connections and waits 5 s for one, so one person who may only read contents, inside the rate limit of the feed, kept the
// pool busy and the readers of another agency got 500.
//
// `content_feed_counters` does what the policy does, once: it asks `has_agency_permission` for the agency of the client (the same
// predicate `contents_select` evaluates for every row of that client, so the numbers are the ones the policy gives) and then counts.
// A caller who is not an active member of that agency, or whose role lacks `conteudo.visualizar`, or an agency that is not active,
// or a client that does not exist, gets no row at all: not zeros, which would say "this client exists and is empty". The agency is
// read from the client, never taken from the caller. Not granted to PUBLIC; `search_path` is empty like the other functions of the
// schema. The filter (formats and the cancelled status) is the one of the feed read; the caller passes the formats so the two
// stay in one place in the API.

export async function up(knex) {
  await knex.raw(`
    create function app_private.content_feed_counters(p_client_id uuid, p_formats text[])
    returns table (posts bigint, approved bigint, awaiting bigint)
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $function$
    begin
      if not app_private.has_agency_permission(app_private.client_agency_id(p_client_id), 'conteudo.visualizar') then
        return;
      end if;

      return query
        select
          count(*),
          count(*) filter (where content.status = 'approved'),
          count(*) filter (where content.status = 'awaiting_approval')
        from public.contents content
        where content.client_id = p_client_id
          and content.format::text = any(p_formats)
          and content.status <> 'cancelled';
    end;
    $function$;
    revoke all on function app_private.content_feed_counters(uuid, text[]) from public;
    grant execute on function app_private.content_feed_counters(uuid, text[]) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
