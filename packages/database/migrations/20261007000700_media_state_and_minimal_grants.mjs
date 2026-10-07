// Issues #295 and #296. Forward-only, like every migration here.
//
// One migration for both, because they meet on `media_assets`; the decisions are recorded in
// docs/business/decisions/2026-10-07-*.md.
//
// #295 -- `media_assets` handed `ageniza_app` INSERT and UPDATE on every column, and the policies
// only ask for `midia.enviar`. A role holding just that permission could set `status` of a rejected
// asset back to `confirmed`, or change `confirmed_size_bytes` of a 100 MB asset to 1 and drop the
// agency's used quota. Three layers, as in `invitations` (20260925, 20261006000200):
//
//  1. INSERT and UPDATE become column grants. `id`, `agency_id`, `category`, the declared values,
//     the object keys, `created_by_user_id` and `created_at` are never writable by an UPDATE, and
//     the state columns (`status`, `confirmed_*`, `rejected_reason`, `video_*`) are not
//     insertable, so no row is born `confirmed`. `ageniza_app` loses DELETE: a rejected upload
//     keeps its row as history, which is what 20260921000000 said and the default privileges undid.
//  2. A BEFORE UPDATE trigger holds the direction of `status`: only pending -> confirmed and
//     pending -> rejected. The outcome (`confirmed_size_bytes`, `confirmed_content_type`,
//     `confirmed_at`, `rejected_reason`) is written once, with the status, and never again.
//  3. The trigger is security invoker and keyed on `current_user`, not on the `app.user_id` GUC
//     (docs/security-review.md, lessons). It reads OLD once the row is locked, so two concurrent
//     transactions cannot slip past it the way a WITH CHECK sub-select could.
//
// Limit, recorded in the decision: the API and the worker connect as `ageniza_app` on behalf of the
// user, so the database cannot tell the server from a holder of `midia.enviar` who runs SQL. What
// it holds is the shape of the transition, not the proof that the content was validated.
//
// #296 -- `agencies`, `agency_storage_quotas`, `roles`, `role_permissions` and `permissions` have
// no UPDATE policy, and nothing in the application updates them, so `ageniza_app` keeps SELECT only
// (INSERT stays as it is). DELETE goes from those five tables and from `client_memberships`;
// `media_assets` loses it above. `client_memberships` keeps its column UPDATE grant (onboarding).
// `accept_invitation` validates the Terms and Privacy versions as a real date that is not in the
// future, the rule `accept_legal_document` already has; its body is otherwise the one of
// 20261007000300, and `create or replace` keeps owner and grants.
//
// A `select ... for update` needs UPDATE on some column, so `ageniza_app` can no longer even try to
// row-lock `agencies`: the advisory lock of `lockAgencyStorageQuota` is still the mechanism.

export async function up(knex) {
  await knex.raw(`
    revoke insert, update, delete on public.media_assets from ageniza_app;

    grant insert (
      id, agency_id, category, declared_content_type, extension, object_key, upload_object_key,
      declared_size_bytes, created_by_user_id
    ) on public.media_assets to ageniza_app;

    grant update (
      status, confirmed_size_bytes, confirmed_content_type, confirmed_at, rejected_reason,
      multipart_upload_id, updated_at,
      thumbnail_object_key, preview_object_key, video_duration_seconds, video_preview_size_bytes,
      video_thumbnail_size_bytes, video_processing_status, video_processing_error, video_processed_at
    ) on public.media_assets to ageniza_app;

    create function app_private.media_asset_upload_state_is_forward_only()
    returns trigger
    language plpgsql
    set search_path = ''
    as $function$
    begin
      if current_user <> 'ageniza_app' then
        return new;
      end if;

      if new.status is distinct from old.status then
        if old.status <> 'pending' or new.status not in ('confirmed', 'rejected') then
          raise exception using
            errcode = '42501',
            message = 'A media upload can only move from pending to confirmed or rejected.';
        end if;

        if new.status = 'confirmed' and (
          new.confirmed_size_bytes is null
          or new.confirmed_content_type is null
          or new.confirmed_at is null
          or new.rejected_reason is not null
        ) then
          raise exception using
            errcode = '42501',
            message = 'A confirmed media upload carries its confirmed size, content type and time.';
        end if;

        if new.status = 'rejected' and (
          new.rejected_reason is null
          or pg_catalog.btrim(new.rejected_reason) = ''
          or new.confirmed_size_bytes is not null
          or new.confirmed_content_type is not null
          or new.confirmed_at is not null
        ) then
          raise exception using
            errcode = '42501',
            message = 'A rejected media upload carries its reason and no confirmation.';
        end if;
      elsif (new.confirmed_size_bytes, new.confirmed_content_type, new.confirmed_at, new.rejected_reason)
        is distinct from (old.confirmed_size_bytes, old.confirmed_content_type, old.confirmed_at, old.rejected_reason)
      then
        raise exception using
          errcode = '42501',
          message = 'The outcome of a media upload is written once, together with its status.';
      end if;

      return new;
    end;
    $function$;
    revoke all on function app_private.media_asset_upload_state_is_forward_only() from public;

    create trigger media_assets_upload_state_forward_only
      before update on public.media_assets
      for each row
      execute function app_private.media_asset_upload_state_is_forward_only();

    revoke update, delete on
      public.agencies, public.agency_storage_quotas, public.roles, public.role_permissions, public.permissions
      from ageniza_app;
    revoke delete on public.client_memberships from ageniza_app;

    create or replace function app_private.accept_invitation(
      p_token_hash text,
      p_user_id uuid,
      p_terms_version text,
      p_privacy_version text,
      p_record_acceptance boolean
    )
    returns table (status text, agency_id uuid, client_id uuid)
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      invitation public.invitations%rowtype;
      agency public.agencies%rowtype;
      invited_user_email text;
      admin_role_id uuid;
      already_member boolean := false;
      v_terms_date date;
      v_privacy_date date;
      v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
    begin
      select *
      into invitation
      from public.invitations
      where token_hash = p_token_hash
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
        insert into public.client_memberships (client_id, user_id)
        values (invitation.client_id, p_user_id)
        on conflict on constraint client_memberships_client_id_user_id_key do update
          set status = 'active', updated_at = pg_catalog.now();
      end if;

      update public.invitations
      set used_at = pg_catalog.now(), accepted_by_user_id = p_user_id
      where id = invitation.id;

      if p_record_acceptance then
        insert into public.legal_acceptances (user_id, document, version)
        values
          (p_user_id, 'terms', p_terms_version),
          (p_user_id, 'privacy', p_privacy_version)
        on conflict (user_id, document, version) do nothing;
      end if;

      insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
      values ('invitation.accepted', p_user_id, invitation.agency_id, 'invitation', invitation.id);

      if invitation.purpose = 'agency_activation' then
        insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
        values ('agency.activated', p_user_id, invitation.agency_id, 'agency', invitation.agency_id);
      end if;

      return query select 'accepted'::text, invitation.agency_id, invitation.client_id;
    end;
    $function$;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
