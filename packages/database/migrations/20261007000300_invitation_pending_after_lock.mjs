/**
 * Issue #304, finding 3 (security review of PR #298, issue #165).
 *
 * `app_private.accept_invitation` decided "expired" with `now()`, the transaction clock frozen at
 * the start of the request. When the acceptance waited on the invitation row lock (`for update`)
 * and the invitation expired during that wait, the function still saw the invitation it had read
 * at the start and accepted it. The check now uses `clock_timestamp()`, evaluated after both
 * `for update` locks were taken, so the decision is made on the version of the row the acceptance
 * actually uses -- the same "decide after the wait" rule the resend and cancel routes apply with a
 * second `statement_timestamp()` read (see decisions.md, 2026-10-07).
 *
 * `create or replace` keeps the function's owner and privileges, so the existing grants to
 * `ageniza_app` stay untouched and the trigger/policies are not recreated; no table, column,
 * policy or grant changes.
 */
export async function up(knex) {
  await knex.raw(`
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

      -- clock_timestamp(), not now() nor statement_timestamp(): now() is the transaction
      -- start, before both waits, and inside a single function call statement_timestamp() never
      -- advances past them. This is the same "decide after the lock" rule the routes apply in a
      -- second statement (issue #304).
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
