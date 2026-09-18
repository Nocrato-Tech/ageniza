import { raw } from '@ageniza/database';

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface ConfirmedVideoAssetRow {
  readonly id: string;
  readonly agency_id: string;
  readonly object_key: string;
  readonly video_processing_status: 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed';
}

/**
 * Locks and returns the confirmed video asset the job refers to, scoped by both `id` and
 * `agency_id` (issue #24: "process only objects referenced in the database and belonging to the
 * job's tenant"). This runs inside a transaction authenticated as the asset's own uploading user
 * (`withAuthenticatedUserTransaction`), so it goes through the exact same RLS policy the API
 * itself is bound by -- the worker never bypasses row-level security (ADR 0011).
 */
export const lockConfirmedVideoAsset = async (
  transaction: Parameters<typeof raw>[0],
  input: { readonly assetId: string; readonly agencyId: string }
): Promise<ConfirmedVideoAssetRow | undefined> => {
  const result = await raw<RawRows<ConfirmedVideoAssetRow>>(transaction, `
    select id, agency_id, object_key, video_processing_status
    from public.media_assets
    where id = ?::uuid and agency_id = ?::uuid and category = 'video' and status = 'confirmed'
    for update
  `, [input.assetId, input.agencyId]);
  return result.rows[0];
};

export const markVideoProcessingStarted = async (transaction: Parameters<typeof raw>[0], assetId: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set video_processing_status = 'processing', video_processing_error = null, updated_at = now()
    where id = ?::uuid
  `, [assetId]);
};

/** Returns a failed attempt to a non-terminal state while pg-boss still has retries available. */
export const markVideoProcessingRetrying = async (transaction: Parameters<typeof raw>[0], assetId: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set video_processing_status = 'pending', video_processing_error = null, video_processed_at = null, updated_at = now()
    where id = ?::uuid
  `, [assetId]);
};

export interface VideoProcessingResult {
  readonly thumbnailObjectKey: string;
  readonly previewObjectKey: string;
  readonly durationSeconds: number;
  readonly thumbnailSizeBytes: number;
  readonly previewSizeBytes: number;
}

export const markVideoProcessingReady = async (
  transaction: Parameters<typeof raw>[0],
  assetId: string,
  result: VideoProcessingResult
): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set
      video_processing_status = 'ready',
      thumbnail_object_key = ?,
      preview_object_key = ?,
      video_duration_seconds = ?,
      video_thumbnail_size_bytes = ?,
      video_preview_size_bytes = ?,
      video_processing_error = null,
      video_processed_at = now(),
      updated_at = now()
    where id = ?::uuid
  `, [
    result.thumbnailObjectKey, result.previewObjectKey, result.durationSeconds,
    result.thumbnailSizeBytes, result.previewSizeBytes, assetId
  ]);
};

/** `reason` is a short, fixed classification -- never raw ffmpeg output or a signed URL. */
export const markVideoProcessingFailed = async (transaction: Parameters<typeof raw>[0], assetId: string, reason: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set video_processing_status = 'failed', video_processing_error = ?, video_processed_at = now(), updated_at = now()
    where id = ?::uuid
  `, [reason, assetId]);
};
