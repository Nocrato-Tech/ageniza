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
  defaults: { readonly quotaBytes: number; readonly quotaObjectCount: number }
): Promise<QuotaSnapshot> => {
  const overrideResult = await raw<RawRows<QuotaOverrideRow>>(transaction, `
    select quota_bytes, quota_object_count from public.agency_storage_quotas where agency_id = ?::uuid
  `, [agencyId]);
  const override = overrideResult.rows[0];

  const usageResult = await raw<RawRows<UsageRow>>(transaction, `
    select
      coalesce(sum(confirmed_size_bytes), 0) as used_bytes,
      count(*) as used_object_count
    from public.media_assets
    where agency_id = ?::uuid and status = 'confirmed'
  `, [agencyId]);
  const usage = usageResult.rows[0];

  return {
    quotaBytes: toNumber(override?.quota_bytes ?? null, defaults.quotaBytes),
    quotaObjectCount: toNumber(override?.quota_object_count ?? null, defaults.quotaObjectCount),
    usedBytes: toNumber(usage?.used_bytes ?? null, 0),
    usedObjectCount: toNumber(usage?.used_object_count ?? null, 0)
  };
};

export interface PendingAssetInput {
  readonly id: string;
  readonly agencyId: string;
  readonly category: MediaCategory;
  readonly declaredContentType: string;
  readonly extension: string;
  readonly objectKey: string;
  readonly declaredSizeBytes: number;
  readonly createdByUserId: string;
}

export const insertPendingAsset = async (transaction: Transaction, input: PendingAssetInput): Promise<void> => {
  await raw(transaction, `
    insert into public.media_assets
      (id, agency_id, category, declared_content_type, extension, object_key, declared_size_bytes, created_by_user_id)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    input.id, input.agencyId, input.category, input.declaredContentType, input.extension,
    input.objectKey, input.declaredSizeBytes, input.createdByUserId
  ]);
};

export const setMultipartUploadId = async (transaction: Transaction, assetId: string, uploadId: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets set multipart_upload_id = ?, updated_at = now() where id = ?::uuid
  `, [uploadId, assetId]);
};

export interface MediaAssetRow {
  readonly id: string;
  readonly agency_id: string;
  readonly category: MediaCategory;
  readonly object_key: string;
  readonly status: 'pending' | 'confirmed' | 'rejected';
  readonly declared_size_bytes: string | number;
  readonly multipart_upload_id: string | null;
}

/** Locks the row so two concurrent confirm/complete calls for the same asset cannot race. */
export const lockAssetForCompletion = async (transaction: Transaction, assetId: string, agencyId: string): Promise<MediaAssetRow | undefined> => {
  const result = await raw<RawRows<MediaAssetRow>>(transaction, `
    select id, agency_id, category, object_key, status, declared_size_bytes, multipart_upload_id
    from public.media_assets
    where id = ?::uuid and agency_id = ?::uuid
    for update
  `, [assetId, agencyId]);
  return result.rows[0];
};

export const markAssetConfirmed = async (transaction: Transaction, assetId: string, sizeBytes: number, contentType: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets
    set status = 'confirmed', confirmed_size_bytes = ?, confirmed_content_type = ?, confirmed_at = now(), updated_at = now()
    where id = ?::uuid
  `, [sizeBytes, contentType, assetId]);
};

export const markAssetRejected = async (transaction: Transaction, assetId: string, reason: string): Promise<void> => {
  await raw(transaction, `
    update public.media_assets set status = 'rejected', rejected_reason = ?, updated_at = now() where id = ?::uuid
  `, [reason, assetId]);
};

export const findConfirmedAsset = async (transaction: Transaction, assetId: string, agencyId: string): Promise<{ readonly objectKey: string } | undefined> => {
  const result = await raw<RawRows<{ object_key: string }>>(transaction, `
    select object_key from public.media_assets where id = ?::uuid and agency_id = ?::uuid and status = 'confirmed'
  `, [assetId, agencyId]);
  const row = result.rows[0];
  return row === undefined ? undefined : { objectKey: row.object_key };
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
