import { raw } from '@ageniza/database';

import type { MediaCategory } from '@ageniza/contracts';

type Transaction = Parameters<typeof raw>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface QuotaSnapshot {
  readonly quotaBytes: number;
  readonly quotaObjectCount: number;
  readonly usedBytes: number;
  readonly usedObjectCount: number;
}

interface QuotaOverrideRow {
  readonly quota_bytes: string | number | null;
  readonly quota_object_count: string | number | null;
}

interface UsageRow {
  readonly used_bytes: string | number | null;
  readonly used_object_count: string | number | null;
}

const toNumber = (value: string | number | null, fallback: number): number => {
  if (value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Reads the agency's quota override (if any) and current confirmed usage in one round trip.
 * `agency_storage_quotas` is select-only for `ageniza_app` -- overrides are written by operators
 * directly against the database, never through the API (issue #21 does not ask for that UI). */
export const readQuotaSnapshot = async (
  transaction: Transaction,
  agencyId: string,
  defaults: { readonly quotaBytes: number; readonly quotaObjectCount: number },
  options: { readonly excludeAssetId?: string; readonly pendingReservationSeconds: number }
): Promise<QuotaSnapshot> => {
  const overrideResult = await raw<RawRows<QuotaOverrideRow>>(transaction, `
    select quota_bytes, quota_object_count from public.agency_storage_quotas where agency_id = ?::uuid
  `, [agencyId]);
  const override = overrideResult.rows[0];

  const usageResult = await raw<RawRows<UsageRow>>(transaction, `
    select
      coalesce(sum(case
        when status = 'confirmed' then confirmed_size_bytes
        when status = 'pending' then declared_size_bytes
      end), 0) as used_bytes,
      count(*) as used_object_count
    from public.media_assets
    where agency_id = ?::uuid
      and id <> coalesce(?::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      and (
        status = 'confirmed'
        or (status = 'pending' and updated_at >= now() - (?::integer * interval '1 second'))
      )
  `, [agencyId, options.excludeAssetId ?? null, options.pendingReservationSeconds]);
  const usage = usageResult.rows[0];

  return {
    quotaBytes: toNumber(override?.quota_bytes ?? null, defaults.quotaBytes),
    quotaObjectCount: toNumber(override?.quota_object_count ?? null, defaults.quotaObjectCount),
    usedBytes: toNumber(usage?.used_bytes ?? null, 0),
    usedObjectCount: toNumber(usage?.used_object_count ?? null, 0)
  };
};

/** Serializes every quota decision for one agency. Advisory locks avoid RLS's separate UPDATE
 * policy requirement for SELECT ... FOR UPDATE, which would otherwise turn a missing policy into
 * a successful query that locked no rows. */
export const lockAgencyStorageQuota = async (transaction: Transaction, agencyId: string): Promise<void> => {
  await raw(transaction, 'select pg_advisory_xact_lock(hashtextextended(?::text, 0))', [agencyId]);
};

export interface PendingAssetInput {
  readonly id: string;
  readonly agencyId: string;
  readonly category: MediaCategory;
  readonly declaredContentType: string;
  readonly extension: string;
  readonly objectKey: string;
  readonly uploadObjectKey: string;
  readonly declaredSizeBytes: number;
  readonly createdByUserId: string;
}

export const insertPendingAsset = async (transaction: Transaction, input: PendingAssetInput): Promise<void> => {
  await raw(transaction, `
    insert into public.media_assets
      (id, agency_id, category, declared_content_type, extension, object_key, upload_object_key, declared_size_bytes, created_by_user_id)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    input.id, input.agencyId, input.category, input.declaredContentType, input.extension,
    input.objectKey, input.uploadObjectKey, input.declaredSizeBytes, input.createdByUserId
  ]);
};

export const setMultipartUploadId = async (transaction: Transaction, assetId: string, uploadId: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets set multipart_upload_id = ?, updated_at = now() where id = ?::uuid
  `, [uploadId, assetId]);
};

/** Extends the quota reservation whenever the client resumes a multipart upload. */
export const touchPendingAsset = async (transaction: Transaction, assetId: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets set updated_at = now() where id = ?::uuid and status = 'pending'
  `, [assetId]);
};

export interface MediaAssetRow {
  readonly id: string;
  readonly agency_id: string;
  readonly category: MediaCategory;
  readonly object_key: string;
  readonly upload_object_key: string;
  readonly status: 'pending' | 'confirmed' | 'rejected';
  readonly declared_size_bytes: string | number;
  readonly multipart_upload_id: string | null;
}

/** Locks the row so two concurrent confirm/complete calls for the same asset cannot race. */
export const lockAssetForCompletion = async (transaction: Transaction, assetId: string, agencyId: string): Promise<MediaAssetRow | undefined> => {
  const result = await raw<RawRows<MediaAssetRow>>(transaction, `
    select id, agency_id, category, object_key, upload_object_key, status, declared_size_bytes, multipart_upload_id
    from public.media_assets
    where id = ?::uuid and agency_id = ?::uuid
    for update
  `, [assetId, agencyId]);
  return result.rows[0];
};

/** `category` decides whether this confirmation also queues video processing (issue #24): a
 * video asset moves its `video_processing_status` from 'not_applicable' to 'pending' in the same
 * transaction, so the row already reflects "a job is expected" before the job is even sent. */
export const markAssetConfirmed = async (
  transaction: Transaction,
  assetId: string,
  sizeBytes: number,
  contentType: string,
  category: MediaCategory
): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set
      status = 'confirmed',
      confirmed_size_bytes = ?,
      confirmed_content_type = ?,
      confirmed_at = now(),
      updated_at = now(),
      video_processing_status = case when ? = 'video' then 'pending' else video_processing_status end
    where id = ?::uuid
  `, [sizeBytes, contentType, category, assetId]);
};

export const markAssetRejected = async (transaction: Transaction, assetId: string, reason: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets set status = 'rejected', rejected_reason = ?, updated_at = now() where id = ?::uuid
  `, [reason, assetId]);
};

export interface ConfirmedAssetVariants {
  readonly category: MediaCategory;
  readonly objectKey: string;
  readonly thumbnailObjectKey: string | null;
  readonly previewObjectKey: string | null;
  readonly videoProcessingStatus: 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed';
  readonly videoProcessingError: string | null;
}

/** Finds a confirmed asset and its thumbnail/preview keys, generated by the worker's video
 * processing job (issue #24), so the download-url route can serve any variant. */
export const findConfirmedAssetWithVariants = async (
  transaction: Transaction,
  assetId: string,
  agencyId: string
): Promise<ConfirmedAssetVariants | undefined> => {
  const result = await raw<RawRows<{
    category: MediaCategory;
    object_key: string;
    thumbnail_object_key: string | null;
    preview_object_key: string | null;
    video_processing_status: ConfirmedAssetVariants['videoProcessingStatus'];
    video_processing_error: string | null;
  }>>(transaction, `
    select category, object_key, thumbnail_object_key, preview_object_key,
      video_processing_status, video_processing_error
    from public.media_assets where id = ?::uuid and agency_id = ?::uuid and status = 'confirmed'
  `, [assetId, agencyId]);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    category: row.category,
    objectKey: row.object_key,
    thumbnailObjectKey: row.thumbnail_object_key,
    previewObjectKey: row.preview_object_key,
    videoProcessingStatus: row.video_processing_status,
    videoProcessingError: row.video_processing_error
  };
};

export const auditMediaEvent = async (
  transaction: Transaction,
  event: { readonly action: string; readonly actorUserId: string; readonly agencyId: string; readonly targetId: string }
): Promise<void> => {
  await raw(transaction, `
    insert into audit.events (action, actor_user_id, agency_id, target_type, target_id)
    values (?, ?, ?, 'media_asset', ?)
  `, [event.action, event.actorUserId, event.agencyId, event.targetId]);
};
