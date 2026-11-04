// Decision: docs/business/decisions/2026-11-04-conteudo-herda-a-midia-da-pasta-e-troca-de-pasta.md. Forward-only.
//
// The folder of a content could not change while it held media or a cover: `content_media_content_fk` and `contents_cover_fk`
// tie both to (client, folder) and `contents.folder_id` was a plain column grant. A content now takes what its folder holds and
// may change folder with its media. Three functions, no change to a foreign key and no new policy:
//
//  - `folder_media_for`: the media a format takes from a folder, newest first as the folder lists them (the first one for a
//    format of one media, up to 20 for a carousel). Confirmed and not removed, locked FOR SHARE in the same statement, so a
//    removal that commits while this waits drops the row from the result (READ COMMITTED re-evaluates it) and a media that
//    leaves later finds the content in `content_media`. Not granted to anyone: only the two functions below call it.
//  - `inherit_content_media`: a content just born takes the media of its folder, through `set_content_media` (one copy of
//    the folder, format and state rules).
//  - `move_content_folder`: one transaction that takes the content lock (client, then content, as every writer does), empties
//    the list, writes the folder and clears the cover, then hands the new list (the one the caller chose, or the folder's) to
//    `set_content_media`. The state rules stay where they were: published and cancelled are refused (A0062), an approved
//    content goes back to awaiting approval through the revision, and a content that waits or is approved is never left with a
//    list that does not cover its format (A0065), so a folder that cannot fill it refuses the move like a removal does.
//
// The cover is cleared on a move: it has to be a media of the folder, and the old one is not. The column grant of `folder_id` is
// left as it is (the trigger of 20261011000600 is tied to the writable columns by a catalog test); the API no longer writes the
// column, so the two foreign keys are not tripped by a route any more, and a direct UPDATE of a content that holds media is still
// refused by them.
//
// Lock order of the new path: client FOR SHARE, content FOR UPDATE, then the media FOR SHARE (by the statement of the folder
// read). `remove_media_asset` takes the client, the media FOR UPDATE and then the contents that use the media, so a removal of a
// media this move is inserting meets it on the media row; the cycle, when both wait for each other, is the 40P01 the API
// already answers as "try again" (the accepted one of `set_content_media`).

export async function up(knex) {
  await knex.raw(`
    create function app_private.folder_media_for(p_client_id uuid, p_folder_id uuid, p_format text)
    returns uuid[]
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_ids uuid[];
      v_max integer := case when p_format = 'carousel' then 20 else 1 end;
    begin
      perform app_private.require_read_committed();

      select coalesce(array_agg(picked.id order by picked.created_at desc, picked.id desc), '{}'::uuid[]) into v_ids
      from (
        select asset.id, asset.created_at
        from public.media_assets asset
        where asset.folder_id = p_folder_id
          and asset.client_id = p_client_id
          and asset.status = 'confirmed'
          and asset.removed_at is null
          and case p_format
            when 'image' then asset.category = 'image'
            when 'carousel' then asset.category in ('image', 'video')
            else asset.category = 'video'
          end
        order by asset.created_at desc, asset.id desc
        limit v_max
        for share of asset
      ) picked;

      return v_ids;
    end;
    $function$;
    revoke all on function app_private.folder_media_for(uuid, uuid, text) from public;

    create function app_private.inherit_content_media(p_content_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
    begin
      perform app_private.require_read_committed();
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');
      perform app_private.set_content_media(
        p_content_id,
        app_private.folder_media_for(v_content.client_id, v_content.folder_id, v_content.format)
      );
    end;
    $function$;
    revoke all on function app_private.inherit_content_media(uuid) from public;
    grant execute on function app_private.inherit_content_media(uuid) to ageniza_app;

    create function app_private.move_content_folder(p_content_id uuid, p_folder_id uuid, p_asset_ids uuid[])
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare
      v_content public.contents;
      v_before integer;
      v_ids uuid[];
    begin
      perform app_private.require_read_committed();
      v_content := app_private.lock_content_for_agency(p_content_id, 'conteudo.operar');

      if v_content.status in ('published', 'cancelled') then
        raise exception using errcode = 'A0062', message = 'A published or cancelled content is no longer edited.';
      end if;

      -- Another request got here first: the folder is already the one asked, and only a list the caller chose is still to write.
      if p_folder_id = v_content.folder_id then
        if p_asset_ids is not null then
          perform app_private.set_content_media(p_content_id, p_asset_ids);
        end if;
        return;
      end if;

      select count(*) into v_before from public.content_media item where item.content_id = p_content_id;
      delete from public.content_media where content_id = p_content_id;
      update public.contents set folder_id = p_folder_id, cover_asset_id = null where id = p_content_id;

      v_ids := coalesce(p_asset_ids, app_private.folder_media_for(v_content.client_id, p_folder_id, v_content.format));
      perform app_private.set_content_media(p_content_id, v_ids);

      -- set_content_media returns at once when the list is the one it finds, and an empty list is the one it finds.
      if cardinality(v_ids) = 0 then
        if (select content.status from public.contents content where content.id = p_content_id) in ('awaiting_approval', 'approved') then
          raise exception using errcode = 'A0065', message = 'The media is not complete for the format.';
        end if;
        if v_before > 0 then
          update public.contents set revision = revision + 1 where id = p_content_id and revision = v_content.revision;
        end if;
      end if;
    end;
    $function$;
    revoke all on function app_private.move_content_folder(uuid, uuid, uuid[]) from public;
    grant execute on function app_private.move_content_folder(uuid, uuid, uuid[]) to ageniza_app;
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
