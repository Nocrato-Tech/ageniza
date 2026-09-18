// Hardens issue #21's direct-upload flow without changing the public object-key contract.
// Browser uploads now land on a staging key; only the API can copy a validated object to the
// canonical `original.<ext>` key. This closes the window in which a still-valid presigned PUT
// could overwrite an object after HeadObject validation.

export async function up(knex) {
  await knex.raw(`
    alter table public.media_assets
      add column upload_object_key text null;

    -- Rows created before this migration already uploaded directly to object_key. Keeping that
    -- value makes the migration safe for an in-flight deployment; every new row uses /upload.ext.
    update public.media_assets set upload_object_key = object_key;

    alter table public.media_assets
      alter column upload_object_key set not null,
      add constraint media_assets_upload_object_key_shape check (
        upload_object_key = object_key
        or upload_object_key = agency_id::text || '/' || id::text || '/upload.' || extension
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
