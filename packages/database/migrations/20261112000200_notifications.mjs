// Notifications inside the app (scope redesign-igual, subtask W1-S3: the database layer). Forward-only, like every migration here.
//
// Structural: docs/business/decisions/2026-11-11-estrutural-notificacoes-so-dentro-do-app-com-cinco-eventos.md, specs/notificacoes.md.
// One table, read by the person it is for; written only by `security definer` functions that nobody but other functions of the database
// can execute, in the transaction of the event.
//
//  - `notifications`: no INSERT, UPDATE or DELETE for `ageniza_app`, on the table or on any column. The one policy is a SELECT: the row is the
//    person's (`recipient_user_id` is the actor of the transaction) and the person still holds, today, the permission of its subject
//    (`conteudo.visualizar`, `cliente.visualizar`, and for an invitation the one its purpose asks: `colaborador.visualizar` or
//    `cliente.convidar_usuario`). `has_agency_permission` is the owner's ownership too, so an Owner reads their own and never another's, and
//    nothing here looks at a client link, so the portal reads nothing. The rule lives once, in `notification_is_readable`, which the policy
//    and the two functions that mark as read call.
//  - `read_notification(agency, id)` and `read_all_notifications(agency)` stamp `read_at`; they touch only what the person may read. The
//    first answers false for a notification that is not the person's, not in that agency or not readable, so the route can answer 404.
//  - One internal function per event creates the row: `notify_content_owner` (approved, changes requested, deadline passed),
//    `notify_material_request_answered` and `notify_invitation_accepted`. They share `add_notification`, where the rules of the whole
//    feature sit: nobody to tell is no reason to refuse the event, an archived client and a suspended agency get nothing (the client is
//    locked FOR SHARE first, the order of the archive), and a repeat of the same deadline is dropped by the unique index.
//  - The events call them in their own transaction: `approve_content`, `request_content_changes`, `approve_content_by_portal_approval`,
//    `request_changes_by_portal_approval` and `accept_invitation` are the bodies of their last migrations plus one `perform`. The answer of
//    the client in a request for material is a plain INSERT of the API, so it is an AFTER INSERT row trigger on `client_thread_comments`
//    (it fires after `0_client_thread_comments_lock_active_client`, which already holds the client).
//  - `notify_approval_deadlines_passed()` is the work of the worker, every hour. It locks the clients (key order), then the contents (key
//    order), like the reminders, so it never waits for an archive in a cycle, and skips what is notified already. The instant is the
//    variant of the owner, `notify_approval_deadlines_passed_at`, for a test to fix it (checklist 93).
//
// The summary is built here, never taken from a caller: the client or the person, a verb and the title, up to 160 characters. No body of a
// note or a comment reaches it. The foreign keys cascade, so a test (or a purge) that deletes a content, a client, an agency or a person
// does not stop at a notification; the application role cannot delete anything.

export async function up(knex) {
  await knex.raw(`
    create table public.notifications (
      id uuid not null default gen_random_uuid() primary key,
      agency_id uuid not null,
      recipient_user_id uuid not null,
      kind text not null,
      content_id uuid null,
      thread_id uuid null,
      invitation_id uuid null,
      client_id uuid null,
      approval_round_id uuid null,
      summary text not null,
      created_at timestamptz not null default now(),
      read_at timestamptz null,
      constraint notifications_agency_fk foreign key (agency_id) references public.agencies (id) on delete cascade,
      constraint notifications_recipient_fk foreign key (recipient_user_id) references auth."user" (id) on delete cascade,
      constraint notifications_client_fk foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade,
      constraint notifications_content_fk foreign key (content_id, client_id) references public.contents (id, client_id) on delete cascade,
      constraint notifications_thread_fk foreign key (thread_id) references public.client_threads (id) on delete cascade,
      constraint notifications_invitation_fk foreign key (invitation_id) references public.invitations (id) on delete cascade,
      constraint notifications_round_fk foreign key (approval_round_id, content_id, client_id)
        references public.content_approval_rounds (id, content_id, client_id) on delete cascade,
      constraint notifications_one_subject_check check (num_nonnulls(content_id, thread_id, invitation_id) <= 1),
      constraint notifications_kind_subject_check check (
        (kind in ('content_approved', 'content_changes_requested', 'approval_deadline_passed') and content_id is not null and client_id is not null)
        or (kind = 'material_request_answered' and thread_id is not null and client_id is not null)
        or (kind = 'invitation_accepted' and invitation_id is not null)
      ),
      constraint notifications_round_check check ((kind = 'approval_deadline_passed') = (approval_round_id is not null)),
      constraint notifications_summary_check check (pg_catalog.char_length(summary) <= 160 and pg_catalog.btrim(summary) <> '')
    );

    create index notifications_recipient_idx on public.notifications (recipient_user_id, agency_id, created_at desc, id desc);
    create index notifications_unread_idx on public.notifications (recipient_user_id, agency_id) where read_at is null;
    create unique index notifications_deadline_round_key
      on public.notifications (recipient_user_id, kind, content_id, approval_round_id) where approval_round_id is not null;

    alter table public.notifications enable row level security;
    alter table public.notifications force row level security;

    revoke all on public.notifications from ageniza_app;
    grant select on public.notifications to ageniza_app;
  `);

  await knex.raw(`
    -- The one rule of who reads a notification, for the policy and for the functions that mark one as read. A person with no actor in
    -- the transaction reads nothing; the permission of an invitation follows its purpose, and an unknown subject holds no permission.
    create function app_private.notification_is_readable(p_recipient_user_id uuid, p_agency_id uuid, p_kind text, p_invitation_id uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $function$
      select p_recipient_user_id = app_private.current_user_id()
        and app_private.has_agency_permission(
          p_agency_id,
          case p_kind
            when 'content_approved' then 'conteudo.visualizar'
            when 'content_changes_requested' then 'conteudo.visualizar'
            when 'approval_deadline_passed' then 'conteudo.visualizar'
            when 'material_request_answered' then 'cliente.visualizar'
            when 'invitation_accepted' then (
              select case invitation.purpose
                when 'collaborator_invite' then 'colaborador.visualizar'
                when 'client_invite' then 'cliente.convidar_usuario'
              end
              from public.invitations invitation
              where invitation.id = p_invitation_id and invitation.agency_id = p_agency_id
            )
          end
        )
    $function$;
    revoke all on function app_private.notification_is_readable(uuid, uuid, text, uuid) from public;
    grant execute on function app_private.notification_is_readable(uuid, uuid, text, uuid) to ageniza_app;

    create policy notifications_select on public.notifications
      for select to ageniza_app
      using (app_private.notification_is_readable(recipient_user_id, agency_id, kind, invitation_id));
  `);

  await knex.raw(`
    -- A text of the summary, on one line and clipped to p_max characters (an ellipsis counts).
    create function app_private.notification_clip(p_text text, p_max integer)
    returns text
    language sql
    immutable
    set search_path = ''
    as $function$
      select case
        when pg_catalog.char_length(squeezed.text) <= greatest(p_max, 1) then squeezed.text
        else pg_catalog.left(squeezed.text, greatest(p_max, 1) - 1) || '…'
      end
      from (select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_text, ''), '[[:space:]]+', ' ', 'g')) as text) squeezed
    $function$;
    revoke all on function app_private.notification_clip(text, integer) from public;

    -- "prefix "title" suffix" in 160 characters at most: the title gives way, so the quotes close.
    create function app_private.notification_summary(p_prefix text, p_quoted text, p_suffix text)
    returns text
    language sql
    immutable
    set search_path = ''
    as $function$
      select p_prefix || '"'
        || app_private.notification_clip(p_quoted, 158 - pg_catalog.char_length(p_prefix) - pg_catalog.char_length(p_suffix))
        || '"' || p_suffix
    $function$;
    revoke all on function app_private.notification_summary(text, text, text) from public;
  `);

  await knex.raw(`
    -- The one place that decides whether a notification is created. No recipient: nothing, and the event goes on. An archived client or
    -- a suspended agency: nothing. The client is locked FOR SHARE before anything else, as the events do, so an archive in flight is
    -- waited for and then seen. A repeat of the same deadline of the same round is dropped by the unique index (NULL: nothing created).
    create function app_private.add_notification(
      p_kind text, p_recipient_user_id uuid, p_agency_id uuid, p_client_id uuid,
      p_content_id uuid, p_thread_id uuid, p_invitation_id uuid, p_approval_round_id uuid, p_summary text
    )
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_id uuid;
    begin
      if p_recipient_user_id is null then
        return null;
      end if;

      if p_client_id is not null then
        perform 1 from public.clients client
        where client.id = p_client_id and client.agency_id = p_agency_id and client.status = 'active'
        for share;
        if not found then
          return null;
        end if;
      end if;

      perform 1 from public.agencies agency where agency.id = p_agency_id and agency.status = 'active';
      if not found then
        return null;
      end if;

      insert into public.notifications (agency_id, recipient_user_id, kind, content_id, thread_id, invitation_id, client_id, approval_round_id, summary)
      values (p_agency_id, p_recipient_user_id, p_kind, p_content_id, p_thread_id, p_invitation_id, p_client_id, p_approval_round_id, p_summary)
      on conflict do nothing
      returning id into v_id;
      return v_id;
    end;
    $function$;
    revoke all on function app_private.add_notification(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) from public;

    -- The three events about a content tell its responsible (owner_user_id).
    create function app_private.notify_content_owner(p_kind text, p_content_id uuid, p_approval_round_id uuid default null)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents%rowtype;
      v_client public.clients%rowtype;
      v_summary text;
    begin
      select * into v_content from public.contents content where content.id = p_content_id;
      if not found then
        return null;
      end if;
      select * into v_client from public.clients client where client.id = v_content.client_id;

      v_summary := case p_kind
        when 'content_approved' then
          app_private.notification_summary(app_private.notification_clip(v_client.name, 50) || ' aprovou ', v_content.title, '')
        when 'content_changes_requested' then
          app_private.notification_summary(app_private.notification_clip(v_client.name, 50) || ' pediu ajuste em ', v_content.title, '')
        when 'approval_deadline_passed' then
          app_private.notification_summary('O prazo de ', v_content.title, ' venceu')
      end;
      if v_summary is null then
        raise exception using errcode = '22023', message = 'Not a notification about a content.';
      end if;

      return app_private.add_notification(
        p_kind, v_content.owner_user_id, v_client.agency_id, v_client.id, v_content.id, null, null, p_approval_round_id, v_summary
      );
    end;
    $function$;
    revoke all on function app_private.notify_content_owner(text, uuid, uuid) from public;

    -- The answer of the client in a request for material tells who opened the request, while the request is open: a comment on a request
    -- already resolved reopens it at the commit (20260930000300) and notifies nobody.
    create function app_private.notify_material_request_answered(p_thread_id uuid)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_thread public.client_threads%rowtype;
      v_client public.clients%rowtype;
    begin
      select * into v_thread from public.client_threads thread where thread.id = p_thread_id;
      if not found or not v_thread.is_material_request or v_thread.resolved_at is not null then
        return null;
      end if;
      select * into v_client from public.clients client where client.id = v_thread.client_id;

      return app_private.add_notification(
        'material_request_answered', v_thread.opened_by, v_client.agency_id, v_client.id, null, v_thread.id, null, null,
        case
          when v_thread.title is null then app_private.notification_clip(v_client.name, 50) || ' respondeu ao pedido de material'
          else app_private.notification_summary(app_private.notification_clip(v_client.name, 50) || ' respondeu ', v_thread.title, '')
        end
      );
    end;
    $function$;
    revoke all on function app_private.notify_material_request_answered(uuid) from public;

    -- An invitation of a collaborator, or a portal invitation that was still pending, accepted: tells who sent it. The activation of an
    -- agency has no sender to tell.
    create function app_private.notify_invitation_accepted(p_invitation_id uuid)
    returns uuid
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_invitation public.invitations%rowtype;
      v_client_name text;
      v_person text;
    begin
      select * into v_invitation from public.invitations invitation where invitation.id = p_invitation_id;
      if not found or v_invitation.purpose = 'agency_activation' or v_invitation.accepted_by_user_id is null then
        return null;
      end if;
      select coalesce(nullif(pg_catalog.btrim(account.name), ''), 'Alguém') into v_person
      from auth."user" account where account.id = v_invitation.accepted_by_user_id;
      select client.name into v_client_name from public.clients client where client.id = v_invitation.client_id;

      return app_private.add_notification(
        'invitation_accepted', v_invitation.invited_by_user_id, v_invitation.agency_id, v_invitation.client_id, null, null, v_invitation.id, null,
        case
          when v_invitation.purpose = 'client_invite' then
            app_private.notification_clip(v_person, 60) || ' aceitou o seu convite do portal de ' || app_private.notification_clip(v_client_name, 50)
          else app_private.notification_clip(v_person, 100) || ' aceitou o seu convite'
        end
      );
    end;
    $function$;
    revoke all on function app_private.notify_invitation_accepted(uuid) from public;
  `);

  await knex.raw(`
    -- Marks one notification of the person as read and says whether it is theirs, in that agency and readable: false is the "not found" of
    -- the route. It never touches another person's, and keeps the instant of a first read.
    create function app_private.read_notification(p_agency_id uuid, p_notification_id uuid)
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.current_user_id() is null then
        raise exception using errcode = '42501', message = 'Notifications are read by an account.';
      end if;

      update public.notifications notification
      set read_at = pg_catalog.now()
      where notification.id = p_notification_id
        and notification.agency_id = p_agency_id
        and notification.read_at is null
        and app_private.notification_is_readable(notification.recipient_user_id, notification.agency_id, notification.kind, notification.invitation_id);
      if found then
        return true;
      end if;

      return exists (
        select 1 from public.notifications notification
        where notification.id = p_notification_id
          and notification.agency_id = p_agency_id
          and app_private.notification_is_readable(notification.recipient_user_id, notification.agency_id, notification.kind, notification.invitation_id)
      );
    end;
    $function$;
    revoke all on function app_private.read_notification(uuid, uuid) from public;
    grant execute on function app_private.read_notification(uuid, uuid) to ageniza_app;

    -- Marks as read every unread notification of the person in the agency that they may read. The rows are locked in key order, so two
    -- clicks at once wait for each other and never in a cycle. The recipient in the WHERE only lets the index narrow the scan.
    create function app_private.read_all_notifications(p_agency_id uuid)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_actor uuid := app_private.current_user_id();
      v_marked integer;
    begin
      if v_actor is null then
        raise exception using errcode = '42501', message = 'Notifications are read by an account.';
      end if;

      with target as (
        select notification.id
        from public.notifications notification
        where notification.recipient_user_id = v_actor
          and notification.agency_id = p_agency_id
          and notification.read_at is null
          and app_private.notification_is_readable(notification.recipient_user_id, notification.agency_id, notification.kind, notification.invitation_id)
        order by notification.id
        for update
      )
      update public.notifications notification
      set read_at = pg_catalog.now()
      from target
      where notification.id = target.id;
      get diagnostics v_marked = row_count;
      return v_marked;
    end;
    $function$;
    revoke all on function app_private.read_all_notifications(uuid) from public;
    grant execute on function app_private.read_all_notifications(uuid) to ageniza_app;
  `);

  await knex.raw(`
    -- The work of the worker at the instant given: one notification to the responsible of every content that still waits for approval
    -- and whose latest round has a deadline that passed. Only the owner runs it, for a test to fix the instant.
    create function app_private.notify_approval_deadlines_passed_at(p_at timestamptz)
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_candidate record;
      v_created integer := 0;
    begin
      perform app_private.require_read_committed();
      if p_at is null then
        raise exception using errcode = '22023', message = 'The deadlines are judged at an instant.';
      end if;

      -- The clients first, in key order: an archive in flight holds its client, so this waits for it and the statements see what it committed.
      -- Whether a client or an agency still receives anything is decided by add_notification alone.
      perform 1
      from public.clients client
      where client.id in (
        select content.client_id
        from public.content_approval_rounds round
        join public.contents content on content.id = round.content_id and content.client_id = round.client_id
        where round.due_at <= p_at and content.status = 'awaiting_approval'
      )
      order by client.id
      for share of client;

      -- A content told already is skipped before it is locked: the hourly job never queues behind an edit of it.
      for v_candidate in
        select round.id as round_id, content.id as content_id
        from public.content_approval_rounds round
        join public.contents content on content.id = round.content_id and content.client_id = round.client_id
        where round.due_at <= p_at
          and content.status = 'awaiting_approval'
          and round.sequence = (
            select pg_catalog.max(latest.sequence) from public.content_approval_rounds latest where latest.content_id = round.content_id
          )
          and not exists (
            select 1 from public.notifications notified
            where notified.recipient_user_id = content.owner_user_id
              and notified.kind = 'approval_deadline_passed'
              and notified.content_id = content.id
              and notified.approval_round_id = round.id
          )
        order by round.id
        for share of content
      loop
        if app_private.notify_content_owner('approval_deadline_passed', v_candidate.content_id, v_candidate.round_id) is not null then
          v_created := v_created + 1;
        end if;
      end loop;

      return v_created;
    end;
    $function$;
    revoke all on function app_private.notify_approval_deadlines_passed_at(timestamptz) from public;

    create function app_private.notify_approval_deadlines_passed()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval deadlines are notified by the worker, not by a request.';
      end if;
      return app_private.notify_approval_deadlines_passed_at(pg_catalog.now());
    end;
    $function$;
    revoke all on function app_private.notify_approval_deadlines_passed() from public;
    grant execute on function app_private.notify_approval_deadlines_passed() to ageniza_app;
  `);

  await knex.raw(`
    -- The answer of the client in a request for material. AFTER INSERT, so the client was locked by 0_client_thread_comments_lock_active_client
    -- before this writes anything of its own.
    create function app_private.notify_on_client_comment()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    begin
      perform app_private.notify_material_request_answered(new.thread_id);
      return null;
    end;
    $function$;
    revoke all on function app_private.notify_on_client_comment() from public;

    create trigger client_thread_comments_notify_material_request
      after insert on public.client_thread_comments
      for each row
      when (new.author_side = 'client')
      execute function app_private.notify_on_client_comment();
  `);

  // The five functions of the events, as their last migrations left them, plus the call that creates the notification.
  // approve_content: 20261111000203.
  await knex.raw(`
    create or replace function app_private.approve_content(p_content_id uuid, p_revision integer, p_note text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
      v_thread_id uuid;
      v_actor uuid := app_private.current_user_id();
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ('awaiting_approval', 'adjusting', 'approved', 'published')
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if not app_private.approval_note_is_valid(p_note) then
        raise exception using errcode = 'A0068', message = 'The note to the agency is up to 500 characters and not blank.';
      end if;

      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id
      for update;

      if v_status = 'approved' then
        if p_note is not null then
          raise exception using errcode = 'A0123', message = 'The content is already approved and the note was not written.';
        end if;
        return;
      end if;
      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      update public.contents set status = 'approved' where id = p_content_id;

      if p_note is not null then
        -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
        insert into public.client_threads (client_id, content_id, opened_by, opened_side)
        values (v_client_id, p_content_id, v_actor, 'client')
        on conflict (content_id) where content_id is not null do nothing;

        select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

        insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
        values (v_thread_id, v_client_id, v_actor, 'client', p_note);
      end if;

      perform app_private.notify_content_owner('content_approved', p_content_id);
    end;
    $function$;
  `);

  // request_content_changes: 20261007001300.
  await knex.raw(`
    create or replace function app_private.request_content_changes(p_content_id uuid, p_revision integer, p_body text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_client_id uuid;
      v_status text;
      v_revision integer;
      v_thread_id uuid;
      v_actor uuid := app_private.current_user_id();
    begin
      select content.client_id, content.status into v_client_id, v_status
      from public.contents content
      where content.id = p_content_id;

      -- Same door as approve_content: only an active person of the portal of this client, and a content the portal
      -- cannot open yet is "not found" for it.
      if not found or not app_private.is_client_member(v_client_id) or (
        v_status not in ('awaiting_approval', 'adjusting', 'approved', 'published')
        and not app_private.has_agency_permission(app_private.client_agency_id(v_client_id), 'conteudo.visualizar')
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if p_body is null or regexp_replace(p_body, '[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+', '', 'g') = '' or octet_length(p_body) > 5000 then
        raise exception using errcode = 'A0068', message = 'A request for changes carries its comment.';
      end if;

      -- The client is locked before the content, the order archive_client takes: a request that waits for the archiving of the
      -- client finds it archived and answers "not found", instead of moving the content and writing a comment after the archive.
      perform 1 from public.clients client where client.id = v_client_id and client.status = 'active' for share;
      if not found then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id
      for update;

      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval gets a request for changes.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
      insert into public.client_threads (client_id, content_id, opened_by, opened_side)
      values (v_client_id, p_content_id, v_actor, 'client')
      on conflict (content_id) where content_id is not null do nothing;

      select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

      insert into public.client_thread_comments (thread_id, client_id, author_user_id, author_side, body)
      values (v_thread_id, v_client_id, v_actor, 'client', p_body);

      update public.contents set status = 'adjusting' where id = p_content_id;

      perform app_private.notify_content_owner('content_changes_requested', p_content_id);
    end;
    $function$;
  `);

  // approve_content_by_portal_approval and request_changes_by_portal_approval: 20261027090200.
  await knex.raw(`
    create or replace function app_private.approve_content_by_portal_approval(p_session_hash text, p_content_id uuid, p_revision integer)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_session record;
      v_status text;
      v_revision integer;
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval link is used with no account bound to the transaction.';
      end if;
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, true);

      if not exists (
        select 1 from public.client_portal_approval_link_contents lot
        where lot.link_id = v_session.resolved_link_id and lot.content_id = p_content_id
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id and content.client_id = v_session.resolved_client_id
      for update;
      if not found or v_status = 'cancelled' then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if v_status = 'approved' then
        return;
      end if;
      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval is approved.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      insert into app_private.portal_approval_context (xact_id, access_id, link_id)
      values (pg_catalog.pg_current_xact_id(), v_session.resolved_access_id, v_session.resolved_link_id);
      update public.contents set status = 'approved' where id = p_content_id;
      delete from app_private.portal_approval_context where xact_id = pg_catalog.pg_current_xact_id();

      perform app_private.notify_content_owner('content_approved', p_content_id);
    end;
    $function$;

    create or replace function app_private.request_changes_by_portal_approval(p_session_hash text, p_content_id uuid, p_revision integer, p_body text)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_session record;
      v_status text;
      v_revision integer;
      v_thread_id uuid;
    begin
      if app_private.current_user_id() is not null then
        raise exception using errcode = '42501', message = 'The approval link is used with no account bound to the transaction.';
      end if;
      -- Spaces, the characters that draw nothing (zero-width, joiners, direction marks, the byte order mark) and control characters.
      if p_body is null
         or pg_catalog.regexp_replace(p_body, '[[:space:]\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u00a0\\u00ad\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u2060\\u3000\\ufeff]+', '', 'g') = ''
         or pg_catalog.octet_length(p_body) > 5000 then
        raise exception using errcode = 'A0068', message = 'A request for changes carries its comment.';
      end if;
      select * into v_session from app_private.portal_approval_resolve(p_session_hash, true);

      if not exists (
        select 1 from public.client_portal_approval_link_contents lot
        where lot.link_id = v_session.resolved_link_id and lot.content_id = p_content_id
      ) then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      select content.status, content.revision into v_status, v_revision
      from public.contents content
      where content.id = p_content_id and content.client_id = v_session.resolved_client_id
      for update;
      if not found or v_status = 'cancelled' then
        raise exception using errcode = 'A0060', message = 'Content not found.';
      end if;

      if v_status <> 'awaiting_approval' then
        raise exception using errcode = 'A0062', message = 'Only a content awaiting approval gets a request for changes.';
      end if;
      if p_revision is distinct from v_revision then
        raise exception using errcode = 'A0063', message = 'The content changed since it was read.';
      end if;

      insert into app_private.portal_approval_context (xact_id, access_id, link_id)
      values (pg_catalog.pg_current_xact_id(), v_session.resolved_access_id, v_session.resolved_link_id);

      -- The agency may open the conversation at the same moment; the unique index decides and the loser reads it.
      insert into public.client_threads (client_id, content_id, opened_by_portal_access_id, opened_side)
      values (v_session.resolved_client_id, p_content_id, v_session.resolved_access_id, 'client')
      on conflict (content_id) where content_id is not null do nothing;
      select thread.id into v_thread_id from public.client_threads thread where thread.content_id = p_content_id;

      insert into public.client_thread_comments (thread_id, client_id, author_portal_access_id, author_side, body)
      values (v_thread_id, v_session.resolved_client_id, v_session.resolved_access_id, 'client', p_body);

      update public.contents set status = 'adjusting' where id = p_content_id;
      delete from app_private.portal_approval_context where xact_id = pg_catalog.pg_current_xact_id();

      perform app_private.notify_content_owner('content_changes_requested', p_content_id);
    end;
    $function$;
  `);

  // accept_invitation: 20261027080300 (the lookup by either token of 20261027050000 included).
  await knex.raw(`CREATE OR REPLACE FUNCTION app_private.accept_invitation(p_token_hash text, p_user_id uuid, p_terms_version text, p_privacy_version text, p_record_acceptance boolean)
 RETURNS TABLE(status text, agency_id uuid, client_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    declare
      invitation public.invitations%rowtype;
      agency public.agencies%rowtype;
      invited_user_email text;
      admin_role_id uuid;
      already_member boolean := false;
      v_terms_date date;
      v_privacy_date date;
      v_today date := app_private.sao_paulo_date(pg_catalog.now());
    begin
      select *
      into invitation
      from public.invitations
      where (token_hash = p_token_hash or email_token_hash = p_token_hash)
      for update;

      if not found then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select agency_row.*
      into agency
      from public.agencies agency_row
      where agency_row.id = invitation.agency_id
      for update;

      -- After both locks: now() and statement_timestamp() would not see the wait pass (issue #304).
      if not found
         or invitation.used_at is not null
         or invitation.revoked_at is not null
         or invitation.expires_at <= pg_catalog.clock_timestamp()
         or agency.status <> 'active'
         or not app_private.agency_accepts_writes(agency.id)
      then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      if invitation.client_id is not null then
        if not exists (
          select 1
          from public.clients invited_client
          where invited_client.id = invitation.client_id
            and invited_client.agency_id = invitation.agency_id
            and invited_client.status = 'active'
        ) then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;
      end if;

      if invitation.role_id is not null and not exists (
        select 1
        from public.roles invited_role
        where invited_role.id = invitation.role_id
          and (invited_role.agency_id is null or invited_role.agency_id = invitation.agency_id)
      ) then
        raise exception using
          errcode = 'A0001',
          message = 'Invitation link is not valid.';
      end if;

      select "email"
      into invited_user_email
      from auth."user"
      where id = p_user_id;

      if not found or invited_user_email <> invitation.email then
        raise exception using
          errcode = 'A0002',
          message = 'The authenticated account does not match this invitation.';
      end if;

      if invitation.purpose = 'agency_activation' then
        already_member := agency.owner_user_id = p_user_id;
      elsif invitation.purpose = 'collaborator_invite' then
        select exists (
          select 1
          from public.agency_memberships existing_membership
          where existing_membership.agency_id = invitation.agency_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      else
        select exists (
          select 1
          from public.client_memberships existing_membership
          where existing_membership.client_id = invitation.client_id
            and existing_membership.user_id = p_user_id
            and existing_membership.status = 'active'
        ) into already_member;
      end if;

      if already_member then
        return query select 'already_member'::text, invitation.agency_id, invitation.client_id;
        return;
      end if;

      if p_record_acceptance
         and (
           p_terms_version is null or pg_catalog.btrim(p_terms_version) = ''
           or p_privacy_version is null or pg_catalog.btrim(p_privacy_version) = ''
         )
      then
        raise exception using
          errcode = 'A0003',
          message = 'Terms and privacy versions are required.';
      end if;

      -- Issue #296: a version that is not a real date, or is in the future, is refused here as
      -- accept_legal_document refuses it; a future one would suppress every real version later.
      if p_record_acceptance then
        if p_terms_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_privacy_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception using
            errcode = 'A0031',
            message = 'Malformed legal document version.';
        end if;

        begin
          v_terms_date := p_terms_version::date;
          v_privacy_date := p_privacy_version::date;
        exception when datetime_field_overflow or invalid_datetime_format then
          raise exception using
            errcode = 'A0031',
            message = 'The version is not a real date.';
        end;

        if v_terms_date > v_today or v_privacy_date > v_today then
          raise exception using
            errcode = 'A0031',
            message = 'The version is in the future.';
        end if;
      end if;

      if invitation.purpose = 'agency_activation' then
        if agency.owner_user_id is not null then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        select system_role.id
        into admin_role_id
        from public.roles system_role
        where system_role.agency_id is null and system_role.key = 'admin';

        if not found then
          raise exception using
            errcode = 'A0001',
            message = 'Invitation link is not valid.';
        end if;

        update public.agencies
        set owner_user_id = p_user_id, updated_at = pg_catalog.now()
        where id = invitation.agency_id;

        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, admin_role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      elsif invitation.purpose = 'collaborator_invite' then
        insert into public.agency_memberships (agency_id, user_id, role_id)
        values (invitation.agency_id, p_user_id, invitation.role_id)
        on conflict on constraint agency_memberships_agency_id_user_id_key do update
          set role_id = excluded.role_id, status = 'active', updated_at = pg_catalog.now();
      else
        -- A portal invitation is no longer created, and one still pending is accepted into the access of its address.
        perform app_private.grant_client_portal_access_from_invitation(invitation.client_id, p_user_id, invitation.email);
      end if;

      update public.invitations
      set used_at = pg_catalog.now(), accepted_by_user_id = p_user_id
      where id = invitation.id;

      perform app_private.notify_invitation_accepted(invitation.id);

      if p_record_acceptance then
        insert into public.legal_acceptances (user_id, document, version)
        values
          (p_user_id, 'terms', p_terms_version),
          (p_user_id, 'privacy', p_privacy_version)
        on conflict (user_id, document, version) where revoked_at is null do nothing;
      end if;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('invitation.accepted', p_user_id, invitation.agency_id, 'invitation', invitation.id);

      if invitation.purpose = 'agency_activation' then
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('agency.activated', p_user_id, invitation.agency_id, 'agency', invitation.agency_id);
      end if;

      return query select 'accepted'::text, invitation.agency_id, invitation.client_id;
    end;
    $function$;`);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
