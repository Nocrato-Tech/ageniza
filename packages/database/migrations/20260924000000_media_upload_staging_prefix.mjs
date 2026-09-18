// Moves new upload staging objects under a common leading `staging/` prefix. Cloudflare R2
// lifecycle filters match only the beginning of an object key, so the previous per-asset
// `<agency>/<asset>/upload.<ext>` shape could not be expired without also matching canonical
// originals. The old shape remains valid for pending uploads created during a rolling deploy.

export async function up(knex) {
  await knex.raw(`
    alter table public.media_assets
      drop constraint media_assets_upload_object_key_shape,
      add constraint media_assets_upload_object_key_shape check (
        upload_object_key = object_key
        or upload_object_key = agency_id::text || '/' || id::text || '/upload.' || extension
        or upload_object_key = 'staging/' || agency_id::text || '/' || id::text || '/upload.' || extension
      );
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
