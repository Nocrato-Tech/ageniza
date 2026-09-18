// MEDIA-24 domain. Forward-only, like every other migration here: schema and policy corrections
// must be made by a subsequent migration, never by changing an applied file.
//
// Adds worker-owned columns to the existing `media_assets` table (issue #21) so the worker
// (issue #24) can record the outcome of thumbnail/preview generation for a confirmed video asset.
// No RLS or grant changes are needed: the table already has row-level security forced and
// `ageniza_app` already holds `update` on the whole row (issue #21's migration), which covers
// these new columns too. The worker never bypasses RLS -- it authenticates its transaction as the
// asset's uploading user, exactly like the API does (ADR 0011).

export async function up(knex) {
  await knex.raw(`
    alter table public.media_assets
      -- Minted by the worker itself from (agency_id, id), never from any file content -- same
      -- shape invariant as object_key in the #21 migration.
      add column thumbnail_object_key text null,
      add column preview_object_key text null,
      -- ffprobe-reported duration of the original video; null until processed.
      add column video_duration_seconds numeric(10, 3) null check (video_duration_seconds is null or video_duration_seconds > 0),
      add column video_preview_size_bytes bigint null check (video_preview_size_bytes is null or video_preview_size_bytes > 0),
      add column video_thumbnail_size_bytes bigint null check (video_thumbnail_size_bytes is null or video_thumbnail_size_bytes > 0),
      -- 'not_applicable' for images and for videos not yet confirmed. Set to 'pending' by the API
      -- in the same transaction that confirms a video upload, then owned by the worker.
      add column video_processing_status text not null default 'not_applicable'
        check (video_processing_status in ('not_applicable', 'pending', 'processing', 'ready', 'failed')),
      -- A short, non-sensitive failure reason (never a signed URL, never raw ffmpeg output).
      add column video_processing_error text null,
      add column video_processed_at timestamptz null,
      add constraint media_assets_thumbnail_key_shape check (
        thumbnail_object_key is null or thumbnail_object_key = agency_id::text || '/' || id::text || '/thumbnail.jpg'
      ),
      add constraint media_assets_preview_key_shape check (
        preview_object_key is null or preview_object_key = agency_id::text || '/' || id::text || '/preview.mp4'
      ),
      -- Only a video can ever leave 'not_applicable'.
      add constraint media_assets_video_processing_category check (
        category = 'video' or video_processing_status = 'not_applicable'
      );

    create index media_assets_video_processing_status_idx
      on public.media_assets (video_processing_status)
      where video_processing_status = 'pending';
  `);
}

export async function down() {
  throw new Error('Migrations are forward-only; write a new migration instead.');
}
