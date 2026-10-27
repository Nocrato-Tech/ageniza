// The daily e-mail count of an agency, for any instant (issue #727, epic #718).
//
// `agency_emails_today` read the clock inside its own body, so a test could not place "now" at 00:30 or 23:30 of São Paulo.
// The count moves to `agency_emails_sent_on_day(agency, instant)`, the e-mails sent on the day of São Paulo that holds the
// instant, with the same sources and the same cut as before; `agency_emails_today` is that function at `now()`.
// Behaviour does not change. The two-day window on both sides only lets the index narrow the rows; the day is cut by
// `app_private.sao_paulo_date`.

export async function up(knex) {
  await knex.raw(`
    create function app_private.agency_emails_sent_on_day(p_agency_id uuid, p_at timestamptz)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        (select pg_catalog.count(*)
         from public.invitations invitation
         where invitation.agency_id = p_agency_id
           and invitation.purpose in ('collaborator_invite', 'client_invite')
           and invitation.created_at > p_at - interval '2 days'
           and invitation.created_at < p_at + interval '2 days'
           and app_private.sao_paulo_date(invitation.created_at) = app_private.sao_paulo_date(p_at))
        +
        (select pg_catalog.count(*)
         from audit.events event
         where event.agency_id = p_agency_id
           and event.action in ('client_member.added', 'client_member.readded')
           and event.occurred_at > p_at - interval '2 days'
           and event.occurred_at < p_at + interval '2 days'
           and app_private.sao_paulo_date(event.occurred_at) = app_private.sao_paulo_date(p_at))
    $function$;
    revoke all on function app_private.agency_emails_sent_on_day(uuid, timestamptz) from public;

    create or replace function app_private.agency_emails_today(p_agency_id uuid)
    returns bigint
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select app_private.agency_emails_sent_on_day(p_agency_id, pg_catalog.now())
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
