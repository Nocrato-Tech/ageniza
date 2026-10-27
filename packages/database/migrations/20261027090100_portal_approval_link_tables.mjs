// The approval link of the e-mail "conteúdos para aprovar" (issue #712, epic #718): the tables, the context that carries the access
// into a decision, and the authorship the link writes.
// Structural: docs/business/decisions/2026-10-26-estrutural-o-e-mail-de-aprovacao-leva-um-link-que-aprova-sem-login.md and
// docs/business/decisions/2026-10-27-o-link-de-aprovacao-decide-pelo-contexto-da-transacao-e-abre-a-conversa-como-acesso.md.
//
// - client_portal_approval_links / _link_contents / _sessions: one link per access and per e-mail, tied to the contents of the batch,
//   and the sessions the token is exchanged for. The database keeps only the hashes. `ageniza_app` has no grant on any of them; the
//   functions of 20261027090200 are the only door.
// - app_private.portal_approval_context: the access that decides, one row per transaction, written only by the function of the
//   decision. A `set_config` would prove nothing (anyone who runs SQL in the session sets it), so contents_guard and the two guards of
//   the conversation read this row, which the application role cannot write. It follows `app_private.actor_context`.
// - client_threads.opened_by_portal_access_id: a request for changes through the link may open the conversation of the content, and
//   `opened_by` was `not null` and an account.
// - The name of an access in the labels shows only after the account entered that portal (first_entered_at). Until the link,
//   the label was unreachable for an access that had not entered; now an access approves without entering.

export async function up(knex) {
  await knex.raw(`
    create table public.client_portal_approval_links (
      id uuid primary key default gen_random_uuid(),
      portal_access_id uuid not null,
      client_id uuid not null,
      -- The generation of the access when the link was issued: removing the access advances it, and a link of an earlier one is dead for good.
      generation integer not null,
      token_hash text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      constraint client_portal_approval_links_access_fkey
        foreign key (portal_access_id, client_id) references public.client_portal_accesses (id, client_id) on delete cascade,
      constraint client_portal_approval_links_token_hash_key unique (token_hash),
      constraint client_portal_approval_links_id_client_id_key unique (id, client_id),
      constraint client_portal_approval_links_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint client_portal_approval_links_generation_check check (generation >= 1),
      -- Seven days at most, whatever function wrote the row.
      constraint client_portal_approval_links_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '7 days')
    );
    create index client_portal_approval_links_access_idx on public.client_portal_approval_links (portal_access_id);

    -- The batch: the link opens these contents and no other.
    create table public.client_portal_approval_link_contents (
      link_id uuid not null,
      content_id uuid not null,
      client_id uuid not null,
      primary key (link_id, content_id),
      constraint client_portal_approval_link_contents_link_fkey
        foreign key (link_id, client_id) references public.client_portal_approval_links (id, client_id) on delete cascade,
      constraint client_portal_approval_link_contents_content_fkey
        foreign key (content_id, client_id) references public.contents (id, client_id)
    );
    create index client_portal_approval_link_contents_content_idx on public.client_portal_approval_link_contents (content_id);

    -- What the token is exchanged for: the cookie. Short, and never past the link.
    create table public.client_portal_approval_sessions (
      id uuid primary key default gen_random_uuid(),
      link_id uuid not null references public.client_portal_approval_links (id) on delete cascade,
      session_hash text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      constraint client_portal_approval_sessions_session_hash_key unique (session_hash),
      constraint client_portal_approval_sessions_session_hash_check check (session_hash ~ '^[0-9a-f]{64}$'),
      constraint client_portal_approval_sessions_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '2 hours')
    );
    create index client_portal_approval_sessions_link_idx on public.client_portal_approval_sessions (link_id);

    alter table public.client_portal_approval_links enable row level security;
    alter table public.client_portal_approval_links force row level security;
    alter table public.client_portal_approval_link_contents enable row level security;
    alter table public.client_portal_approval_link_contents force row level security;
    alter table public.client_portal_approval_sessions enable row level security;
    alter table public.client_portal_approval_sessions force row level security;

    -- No policy and no grant: the application reads and writes these only through the functions of the link.
    revoke all on public.client_portal_approval_links from public;
    revoke all on public.client_portal_approval_links from ageniza_app;
    revoke all on public.client_portal_approval_link_contents from public;
    revoke all on public.client_portal_approval_link_contents from ageniza_app;
    revoke all on public.client_portal_approval_sessions from public;
    revoke all on public.client_portal_approval_sessions from ageniza_app;
  `);

  await knex.raw(`
    create unlogged table app_private.portal_approval_context (
      xact_id xid8 primary key,
      access_id uuid not null,
      link_id uuid not null
    );
    revoke all on app_private.portal_approval_context from public;
    revoke all on app_private.portal_approval_context from ageniza_app;

    -- The access that decides in this transaction, or null. Called by triggers that run as the application role, so it is a
    -- function of its own: the table stays closed.
    create function app_private.portal_approval_access_id()
    returns uuid
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select context.access_id
      from app_private.portal_approval_context context
      where context.xact_id = pg_catalog.pg_current_xact_id_if_assigned()
    $function$;
    revoke all on function app_private.portal_approval_access_id() from public;
    grant execute on function app_private.portal_approval_access_id() to ageniza_app;
  `);

  // contents_guard: the approval is the account in the transaction or the access of the link, never both and never neither.
  await knex.raw(`
    create or replace function app_private.contents_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    declare
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
      v_category text;
      v_status text;
      v_removed_at timestamptz;
      v_link_access uuid;
    begin
      if new.cover_asset_id is not null and (tg_op = 'INSERT' or new.cover_asset_id is distinct from old.cover_asset_id) then
        select asset.category, asset.status, asset.removed_at into v_category, v_status, v_removed_at
        from public.media_assets asset
        where asset.id = new.cover_asset_id;
        -- A cover that is not found is left to the policy and the foreign key.
        if found and (v_category <> 'image' or v_status <> 'confirmed' or v_removed_at is not null) then
          raise exception using
            errcode = 'A0069',
            message = 'The cover of a content is a confirmed image that was not removed.';
        end if;
      end if;

      if tg_op = 'INSERT' then
        return new;
      end if;

      if (new.id, new.client_id, new.platform, new.created_at) is distinct from (old.id, old.client_id, old.platform, old.created_at) then
        raise exception using
          errcode = '42501',
          message = 'The identity of a content never changes.';
      end if;

      if new.status is distinct from old.status then
        if (old.status, new.status) not in (
          ('in_production', 'awaiting_approval'), ('adjusting', 'awaiting_approval'), ('approved', 'awaiting_approval'),
          ('awaiting_approval', 'approved'), ('awaiting_approval', 'adjusting'),
          ('approved', 'published'), ('published', 'approved'),
          ('in_production', 'cancelled'), ('awaiting_approval', 'cancelled'), ('adjusting', 'cancelled'), ('approved', 'cancelled'),
          ('cancelled', 'in_production')
        ) then
          raise exception using
            errcode = '42501',
            message = 'A content only moves along the transitions of its life cycle.';
        end if;

        if (new.title, new.format, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id)
          is distinct from (old.title, old.format, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id)
          or (new.publish_on is distinct from old.publish_on and not (old.status = 'cancelled' and new.status = 'in_production'))
        then
          raise exception using
            errcode = '42501',
            message = 'A change of state carries no other change.';
        end if;

        if new.status = 'awaiting_approval' then
          new.approved_by := null;
          new.approved_by_portal_access_id := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'approved' and old.status = 'awaiting_approval' then
          -- Fixed here, from the actor bound in this transaction or the access of the approval link: no caller chooses who approved or when.
          v_link_access := app_private.portal_approval_access_id();
          new.approved_by := app_private.current_user_id();
          new.approved_by_portal_access_id := v_link_access;
          new.approved_at := pg_catalog.now();
          if (new.approved_by is null) = (v_link_access is null) then
            raise exception using
              errcode = '42501',
              message = 'A content is approved by one person: an account, or the access of an approval link.';
          end if;
        elsif new.status = 'approved' then
          if old.published_at is null or app_private.sao_paulo_date(old.published_at) <> v_today then
            raise exception using
              errcode = 'A0064',
              message = 'A publication is undone only on the day it was made.';
          end if;
          new.approved_by := old.approved_by;
          new.approved_by_portal_access_id := old.approved_by_portal_access_id;
          new.approved_at := old.approved_at;
          new.approved_by_agency_reason := old.approved_by_agency_reason;
          new.published_on := null;
          new.published_at := null;
        elsif new.status = 'published' then
          if new.published_on is null or new.published_on > v_today then
            raise exception using
              errcode = 'A0067',
              message = 'The real date of a publication is today or before, in America/Sao_Paulo.';
          end if;
          new.published_at := pg_catalog.now();
        elsif new.status = 'cancelled' then
          new.cancelled_at := pg_catalog.now();
          new.approved_by := null;
          new.approved_by_portal_access_id := null;
          new.approved_at := null;
          new.approved_by_agency_reason := null;
        elsif new.status = 'in_production' then
          new.cancelled_at := null;
        end if;
      else
        if (new.approved_by, new.approved_by_portal_access_id, new.approved_at, new.approved_by_agency_reason, new.published_on, new.published_at, new.cancelled_at)
          is distinct from (old.approved_by, old.approved_by_portal_access_id, old.approved_at, old.approved_by_agency_reason, old.published_on, old.published_at, old.cancelled_at)
        then
          raise exception using
            errcode = '42501',
            message = 'Who approved, who published and who cancelled a content, and when, is written with the state.';
        end if;

        if old.status in ('published', 'cancelled') and (
          new.title, new.format, new.publish_on, new.publish_at_time, new.caption, new.folder_id, new.cover_asset_id, new.owner_user_id
        ) is distinct from (
          old.title, old.format, old.publish_on, old.publish_at_time, old.caption, old.folder_id, old.cover_asset_id, old.owner_user_id
        ) then
          raise exception using
            errcode = 'A0062',
            message = 'A published or cancelled content is no longer edited.';
        end if;

        if new.caption is distinct from old.caption
          or new.cover_asset_id is distinct from old.cover_asset_id
          or new.format is distinct from old.format
        then
          new.revision := old.revision + 1;
          if old.status = 'approved' then
            new.status := 'awaiting_approval';
            new.approved_by := null;
            new.approved_by_portal_access_id := null;
            new.approved_at := null;
            new.approved_by_agency_reason := null;
          end if;
        end if;
      end if;

      return new;
    end;
    $function$;
  `);

  // The conversation: an access writes a comment, or opens the conversation of a content, only inside the decision of its link.
  await knex.raw(`
    alter table public.client_threads add column opened_by_portal_access_id uuid;
    alter table public.client_threads alter column opened_by drop not null;
    alter table public.client_threads
      add constraint client_threads_opened_by_portal_access_fkey
      foreign key (opened_by_portal_access_id, client_id) references public.client_portal_accesses (id, client_id);
    -- Exactly one opener, and an access opens only the conversation of a content, on the client's side.
    alter table public.client_threads add constraint client_threads_one_opener_check
      check ((opened_by is not null) <> (opened_by_portal_access_id is not null));
    alter table public.client_threads add constraint client_threads_access_opens_content_check
      check (opened_by_portal_access_id is null or (opened_side = 'client' and content_id is not null));
    grant select (opened_by_portal_access_id) on public.client_threads to ageniza_app;

    -- security invoker: they read the access the function of the decision bound, which no other writer can bind.
    create function app_private.portal_access_thread_opener_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if new.opened_by_portal_access_id is not null and new.opened_by_portal_access_id is distinct from app_private.portal_approval_access_id() then
        raise exception using
          errcode = '42501',
          message = 'A portal access writes only through its approval link.';
      end if;
      return new;
    end;
    $function$;

    create function app_private.portal_access_comment_author_guard()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if new.author_portal_access_id is not null and new.author_portal_access_id is distinct from app_private.portal_approval_access_id() then
        raise exception using
          errcode = '42501',
          message = 'A portal access writes only through its approval link.';
      end if;
      return new;
    end;
    $function$;
    revoke all on function app_private.portal_access_thread_opener_guard() from public;
    revoke all on function app_private.portal_access_comment_author_guard() from public;

    create trigger client_threads_portal_access_author
      before insert on public.client_threads
      for each row execute function app_private.portal_access_thread_opener_guard();
    create trigger client_thread_comments_portal_access_author
      before insert on public.client_thread_comments
      for each row execute function app_private.portal_access_comment_author_guard();
  `);

  // The name of the account shows only after it entered THIS portal. The list of Acessos says "ainda não entrou" until then and
  // must not give the account away through the label of an approval either.
  await knex.raw(`
    create or replace function app_private.portal_access_label(p_access_id uuid, p_client_id uuid)
    returns text
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select case when access.first_entered_at is not null then coalesce(member.name, access.email) else access.email end
      from public.client_portal_accesses access
      left join auth."user" member on member.id = access.user_id
      where access.id = p_access_id
        and access.client_id = p_client_id
        and (
          app_private.has_agency_permission(app_private.client_agency_id(p_client_id), 'conteudo.visualizar')
          or app_private.is_client_member(p_client_id)
        )
    $function$;
  `);

  await knex.raw(`
    create or replace function app_private.thread_comment_authors(p_thread_id uuid)
    returns table(author_user_id uuid, author_portal_access_id uuid, author_side text, name text, photo_key text)
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      with readable_thread as (
        select thread.id, thread.client_id, thread.resolved_by
        from public.client_threads thread
        where thread.id = p_thread_id
          and (
            (thread.content_id is null and app_private.is_agency_member(app_private.client_agency_id(thread.client_id)))
            or (
              thread.content_id is not null
              and app_private.has_agency_permission(app_private.client_agency_id(thread.client_id), 'conteudo.visualizar')
            )
            or (
              app_private.is_client_member(thread.client_id)
              and (
                (
                  thread.content_id is null
                  and (
                    thread.persona_id is null
                    or exists (
                      select 1 from public.client_personas persona
                      where persona.id = thread.persona_id and persona.status = 'active'
                    )
                  )
                )
                or (thread.content_id is not null and app_private.content_open_to_client(thread.content_id))
              )
            )
          )
      ),
      authors as (
        select comment.author_user_id, comment.author_portal_access_id, comment.author_side, readable_thread.client_id
        from readable_thread
        join public.client_thread_comments comment on comment.thread_id = readable_thread.id
        union
        -- Only the agency resolves (rule 9), so the resolver is read through the agency link.
        select readable_thread.resolved_by, null::uuid, 'agency'::text, readable_thread.client_id
        from readable_thread
        where readable_thread.resolved_by is not null
      )
      select authors.author_user_id, null::uuid, authors.author_side, member.name, member.image
      from authors
      join public.agency_memberships link
        on authors.author_side = 'agency'
       and link.user_id = authors.author_user_id
       and link.agency_id = app_private.client_agency_id(authors.client_id)
      join auth."user" member on member.id = link.user_id
      union all
      select authors.author_user_id, null::uuid, authors.author_side, member.name, member.image
      from authors
      join public.client_memberships link
        on authors.author_side = 'client'
       and link.user_id = authors.author_user_id
       and link.client_id = authors.client_id
      join auth."user" member on member.id = link.user_id
      union all
      -- An access author shows the name of the account linked to it once that account entered the portal, and the address before.
      select null::uuid, authors.author_portal_access_id, authors.author_side,
             case when access.first_entered_at is not null then coalesce(member.name, access.email) else access.email end,
             case when access.first_entered_at is not null then member.image end
      from authors
      join public.client_portal_accesses access
        on authors.author_portal_access_id = access.id
       and access.client_id = authors.client_id
      left join auth."user" member on member.id = access.user_id
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
