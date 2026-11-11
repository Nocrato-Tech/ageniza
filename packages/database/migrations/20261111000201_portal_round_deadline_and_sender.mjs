// What the portal reads of a round now (scope redesign-igual, subtask A2). Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-11-11-estrutural-a-rodada-de-aprovacao-mostra-ao-cliente-quem-enviou-e-aceita-recado-ao-aprovar.md
// and 2026-11-11-estrutural-o-prazo-de-aprovacao-tem-hora-e-padrao-de-48-horas.md. It changes the shape the portal and the approval link
// read, so the function that answers it is dropped and created again with the same grants.
//
//  - `portal_contents` (the person's own link, the only door of the portal to a content) returns, from the current round of a content
//    that left production: the deadline as an instant (`approval_due_at`), and WHO sent it, as the name and the photo key the agency
//    already shows of that person (`auth.user.name` and `image`, through the sender of the round). The e-mail, the role, the id of the
//    sender and the batch are not columns of the function, and the sender is read from the one round the function already chose: the
//    portal gets no SELECT on `content_approval_rounds`, nor on the people of the agency.
//  - `portal_approval_contents` (the link of the e-mail) is not touched: it still answers the day of the deadline (`approval_due_on`),
//    which stays right, and tells a visitor nothing about the people of the agency. The link still approves without a note.
//  - A round whose sender cannot be read is a round without sender (the join is a left join), never a round that disappears.
//  - Same cut as before: a content in production has no round, a cancelled one is not read, and the portal reads only the rounds of the
//    contents of the client the caller is an active person of.

export async function up(knex) {
  await knex.raw(`
    drop function app_private.portal_contents(uuid, date, date, text[], uuid);

    create function app_private.portal_contents(
      p_client_id uuid,
      p_from date default null,
      p_to date default null,
      p_statuses text[] default null,
      p_content_id uuid default null
    )
    returns table (
      id uuid, title text, platform text, format text, publish_on date, status text,
      revision integer, publish_at_time time, caption text, cover_asset_id uuid, published_on date,
      approval_sent_at timestamptz, approval_due_on date, approval_note text,
      approval_due_at timestamptz, approval_sent_by_name text, approval_sent_by_photo_key text
    )
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select
        content.id, content.title, content.platform, content.format, content.publish_on, content.status,
        case when content.status = 'in_production' then null else content.revision end,
        case when content.status = 'in_production' then null else content.publish_at_time end,
        case when content.status = 'in_production' then null else content.caption end,
        case when content.status = 'in_production' then null else content.cover_asset_id end,
        case when content.status = 'in_production' then null else content.published_on end,
        approval.sent_at, approval.due_on, approval.note,
        approval.due_at, approval.sender_name, approval.sender_photo_key
      from public.contents content
      left join lateral (
        select round.sent_at, round.due_on, round.note, round.due_at, sender.name as sender_name, sender.image as sender_photo_key
        from public.content_approval_rounds round
        left join auth."user" sender on sender.id = round.sent_by
        where round.content_id = content.id and content.status <> 'in_production'
        order by round.sequence desc
        limit 1
      ) approval on true
      where content.client_id = p_client_id
        and app_private.is_client_member(p_client_id)
        and content.status <> 'cancelled'
        and (p_from is null or content.publish_on >= p_from)
        and (p_to is null or content.publish_on <= p_to)
        and (p_statuses is null or content.status = any (p_statuses))
        and (p_content_id is null or content.id = p_content_id)
      order by content.publish_on, content.id
    $function$;
    revoke all on function app_private.portal_contents(uuid, date, date, text[], uuid) from public;
    grant execute on function app_private.portal_contents(uuid, date, date, text[], uuid) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
