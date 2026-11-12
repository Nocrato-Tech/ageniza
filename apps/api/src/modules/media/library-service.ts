import { raw, type SqlBinding } from '@ageniza/database';

import type { ContentStatus, MediaLibraryCategory, MediaLibraryAsset, MediaFolderSummary, MediaUsage } from '@ageniza/contracts';

import { foldTextSql } from '../../plugins/infra/sql-text.js';
import { MEDIA_FOLDER_IN_USE_WINDOW_DAYS } from './policy.js';

type Transaction = Parameters<typeof raw>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

interface Page {
  readonly limit: number;
  readonly offset: number;
}

interface Paged<TRow> {
  readonly rows: readonly TRow[];
  readonly total: number;
}

export interface LibraryAssetRow {
  readonly id: string;
  readonly folder_id: string;
  readonly folder_name: string;
  readonly category: MediaLibraryCategory;
  readonly confirmed_content_type: string;
  readonly confirmed_size_bytes: string | number;
  readonly file_name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt_text: string | null;
  readonly video_processing_status: MediaLibraryAsset['videoProcessingStatus'];
  readonly uploader_membership_id: string | null;
  readonly uploader_name: string | null;
  readonly created_at: Date;
  readonly usage_count: string | number;
}

const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

const personFrom = (membershipId: string | null, name: string | null): MediaLibraryAsset['uploadedBy'] =>
  membershipId === null || name === null ? null : { membershipId, name };

export const libraryAssetFrom = (row: LibraryAssetRow): MediaLibraryAsset => ({
  id: row.id,
  folderId: row.folder_id,
  folderName: row.folder_name,
  category: row.category,
  contentType: row.confirmed_content_type,
  sizeBytes: Number(row.confirmed_size_bytes),
  name: row.file_name,
  width: row.width,
  height: row.height,
  altText: row.alt_text,
  videoProcessingStatus: row.video_processing_status,
  uploadedBy: personFrom(row.uploader_membership_id, row.uploader_name),
  createdAt: new Date(row.created_at).toISOString(),
  usageCount: Number(row.usage_count)
});

// The uploader is named by the link they have with the agency, as a content names its person in charge: `null` when they have none
// (a person of the client's portal), and a link that was removed still names who uploaded.
const UPLOADER_JOINS = `
  left join public.agency_memberships uploader_link
    on uploader_link.agency_id = asset.agency_id and uploader_link.user_id = asset.created_by_user_id
  left join auth."user" uploader_account on uploader_account.id = uploader_link.user_id
`;

// The contents (as a media or as the cover) the reader can see: the row-level security of `contents` and `content_media` decides.
const USAGE_COUNT = `(
  select count(*) from (
    select item.content_id from public.content_media item where item.asset_id = asset.id
    union
    select content.id from public.contents content where content.cover_asset_id = asset.id
  ) used
)`;

const ASSET_COLUMNS = `
  asset.id, asset.folder_id, folder.name as folder_name, asset.category, asset.confirmed_content_type, asset.confirmed_size_bytes,
  asset.file_name, asset.width, asset.height, asset.alt_text, asset.video_processing_status,
  uploader_link.id as uploader_membership_id, uploader_account.name as uploader_name, asset.created_at,
  ${USAGE_COUNT} as usage_count
`;

const ASSET_SOURCE = `
  from public.media_assets asset
  join public.media_folders folder on folder.id = asset.folder_id
  ${UPLOADER_JOINS}
`;

const confirmedOf = 'asset.status = \'confirmed\' and asset.removed_at is null';

export interface LibraryFilters {
  readonly search?: string;
  readonly category?: MediaLibraryCategory;
  readonly folderId?: string;
}

/**
 * One page of the confirmed files of a client across its folders, newest first. The search is by the name, ignoring case and
 * accents, with the `%` and `_` of what was typed taken as plain characters; a file with no name (one uploaded before the name was
 * kept) does not match one. `count(*) over ()` rides the page's own snapshot; a page past the end has no row to carry it, so the
 * total is counted on its own.
 */
export const listLibraryAssets = async (
  transaction: Transaction,
  clientId: string,
  filters: LibraryFilters,
  page: Page
): Promise<Paged<LibraryAssetRow & { readonly total: string | number }>> => {
  const conditions = [`asset.client_id = ?::uuid`, confirmedOf];
  const bindings: SqlBinding[] = [clientId];
  if (filters.category !== undefined) {
    conditions.push('asset.category = ?');
    bindings.push(filters.category);
  }
  if (filters.folderId !== undefined) {
    conditions.push('asset.folder_id = ?::uuid');
    bindings.push(filters.folderId);
  }
  if (filters.search !== undefined && filters.search !== '') {
    conditions.push(`${foldTextSql('asset.file_name')} like ${foldTextSql('?')} escape '\\'`);
    bindings.push(`%${escapeLikePattern(filters.search)}%`);
  }
  const where = conditions.join(' and ');

  const result = await raw<RawRows<LibraryAssetRow & { total: string | number }>>(transaction, `
    select ${ASSET_COLUMNS}, count(*) over () as total
    ${ASSET_SOURCE}
    where ${where}
    order by asset.created_at desc, asset.id desc
    limit ? offset ?
  `, [...bindings, page.limit, page.offset]);
  if (result.rows.length > 0 || page.offset === 0) return { rows: result.rows, total: Number(result.rows[0]?.total ?? 0) };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.media_assets asset where ${where}
  `, bindings);
  return { rows: [], total: Number(count.rows[0]?.total ?? 0) };
};

/** A confirmed file of the client, `undefined` for one that is absent, removed, of another client or that this person cannot read. */
export const loadLibraryAsset = async (transaction: Transaction, clientId: string, assetId: string): Promise<LibraryAssetRow | undefined> => {
  const result = await raw<RawRows<LibraryAssetRow>>(transaction, `
    select ${ASSET_COLUMNS}
    ${ASSET_SOURCE}
    where asset.id = ?::uuid and asset.client_id = ?::uuid and ${confirmedOf}
  `, [assetId, clientId]);
  return result.rows[0];
};

export interface AssetEdit {
  readonly name?: string;
  readonly altText?: string | null;
}

/**
 * Writes the name and/or the alternative text of a confirmed file of the client; only the two columns the grant gives. `false` when
 * no row was written: the file is gone (removed, or never of this client) or the policy refuses the caller, which the route's guards
 * already let through, so it is the file that is gone.
 */
export const editAsset = async (transaction: Transaction, clientId: string, assetId: string, edit: AssetEdit): Promise<boolean> => {
  const assignments = ['updated_at = pg_catalog.now()'];
  const bindings: SqlBinding[] = [];
  if (edit.name !== undefined) {
    assignments.push('file_name = ?');
    bindings.push(edit.name);
  }
  if (edit.altText !== undefined) {
    assignments.push('alt_text = ?');
    bindings.push(edit.altText);
  }
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.media_assets
    set ${assignments.join(', ')}
    where id = ?::uuid and client_id = ?::uuid and status = 'confirmed' and removed_at is null
    returning id
  `, [...bindings, assetId, clientId]);
  return result.rows.length > 0;
};

/** `app_private.move_media_asset`: `true` when THIS call moved the file, `false` when it was already in that folder. */
export const moveAsset = async (transaction: Transaction, assetId: string, folderId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ moved: boolean }>>(transaction, 'select app_private.move_media_asset(?::uuid, ?::uuid) as moved', [assetId, folderId]);
  const row = result.rows[0];
  if (row === undefined || typeof row.moved !== 'boolean') throw new Error('move_media_asset did not return a boolean.');
  return row.moved;
};

interface UsageRow {
  readonly content_id: string;
  readonly title: string;
  readonly status: ContentStatus;
  readonly as_media: boolean;
  readonly as_cover: boolean;
}

export const usageFrom = (row: UsageRow): MediaUsage => ({
  contentId: row.content_id,
  title: row.title,
  status: row.status,
  asMedia: row.as_media,
  asCover: row.as_cover
});

/** The contents of the client that hold the file as a media or as the cover, as far as the reader can see them. */
export const listAssetUsage = async (
  transaction: Transaction,
  clientId: string,
  assetId: string,
  page: Page
): Promise<Paged<UsageRow>> => {
  const where = `
    content.client_id = ?::uuid
    and (
      content.cover_asset_id = ?::uuid
      or exists (select 1 from public.content_media item where item.content_id = content.id and item.asset_id = ?::uuid)
    )
  `;
  const bindings = [clientId, assetId, assetId];
  const result = await raw<RawRows<UsageRow & { total: string | number }>>(transaction, `
    select content.id as content_id, content.title, content.status,
      exists (select 1 from public.content_media item where item.content_id = content.id and item.asset_id = ?::uuid) as as_media,
      (content.cover_asset_id is not distinct from ?::uuid) as as_cover,
      count(*) over () as total
    from public.contents content
    where ${where}
    order by content.publish_on desc, content.created_at desc, content.id
    limit ? offset ?
  `, [assetId, assetId, ...bindings, page.limit, page.offset]);
  if (result.rows.length > 0 || page.offset === 0) return { rows: result.rows, total: Number(result.rows[0]?.total ?? 0) };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.contents content where ${where}
  `, bindings);
  return { rows: [], total: Number(count.rows[0]?.total ?? 0) };
};

interface FolderSummaryRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly is_default: boolean;
  readonly created_at: Date;
  readonly image_count: string | number;
  readonly video_count: string | number;
  readonly pdf_count: string | number;
  readonly audio_count: string | number;
  readonly logo_count: string | number;
  readonly total_size_bytes: string | number;
  readonly last_changed_at: Date;
  readonly uploader_membership_id: string | null;
  readonly uploader_name: string | null;
  readonly in_use_now: boolean;
}

export const folderSummaryFrom = (row: FolderSummaryRow): MediaFolderSummary => {
  const counts = {
    image: Number(row.image_count),
    video: Number(row.video_count),
    pdf: Number(row.pdf_count),
    audio: Number(row.audio_count),
    logo: Number(row.logo_count)
  };
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    isDefault: row.is_default,
    createdAt: new Date(row.created_at).toISOString(),
    counts,
    assetCount: counts.image + counts.video + counts.pdf + counts.audio + counts.logo,
    totalSizeBytes: Number(row.total_size_bytes),
    lastChangedAt: new Date(row.last_changed_at).toISOString(),
    lastUploadedBy: personFrom(row.uploader_membership_id, row.uploader_name),
    inUseNow: row.in_use_now
  };
};

/**
 * The folders of a client in the order of the folder list, each with what it holds: the confirmed files by type, their size, the
 * last change (the folder's own creation, or a confirmed file written or removed in it) and who uploaded the newest one. At most one
 * folder is "in use now": the one that is not a default folder whose files, the ones still in it, were written most recently, if that
 * was within `MEDIA_FOLDER_IN_USE_WINDOW_DAYS`. A file is written, for this, by the confirmation of its upload, its rename and its move
 * into the folder, which is what `filed_at` holds: the alternative text and the processing of a video do not move it.
 */
export const listFolderSummaries = async (
  transaction: Transaction,
  clientId: string,
  page: Page
): Promise<Paged<FolderSummaryRow & { readonly total: string | number }>> => {
  const result = await raw<RawRows<FolderSummaryRow & { total: string | number }>>(transaction, `
    with in_use as (
      select folder.id
      from public.media_folders folder
      cross join lateral (
        select max(asset.filed_at) as written_at
        from public.media_assets asset
        where asset.folder_id = folder.id and ${confirmedOf}
      ) live
      where folder.client_id = ?::uuid and not folder.is_default
        and live.written_at >= pg_catalog.now() - (?::integer * interval '1 day')
      order by live.written_at desc, folder.id
      limit 1
    )
    select folder.id, folder.parent_id, folder.name, folder.is_default, folder.created_at,
      stats.image_count, stats.video_count, stats.pdf_count, stats.audio_count, stats.logo_count, stats.total_size_bytes,
      greatest(folder.created_at, stats.last_written_at) as last_changed_at,
      newest.membership_id as uploader_membership_id, newest.name as uploader_name,
      folder.id in (select id from in_use) as in_use_now,
      count(*) over () as total
    from public.media_folders folder
    cross join lateral (
      select
        count(*) filter (where asset.removed_at is null and asset.category = 'image') as image_count,
        count(*) filter (where asset.removed_at is null and asset.category = 'video') as video_count,
        count(*) filter (where asset.removed_at is null and asset.category = 'pdf') as pdf_count,
        count(*) filter (where asset.removed_at is null and asset.category = 'audio') as audio_count,
        count(*) filter (where asset.removed_at is null and asset.category = 'logo') as logo_count,
        coalesce(sum(asset.confirmed_size_bytes) filter (where asset.removed_at is null), 0) as total_size_bytes,
        greatest(max(asset.updated_at), max(asset.removed_at)) as last_written_at
      from public.media_assets asset
      where asset.folder_id = folder.id and asset.status = 'confirmed'
    ) stats
    left join lateral (
      select uploader_link.id as membership_id, uploader_account.name as name
      from public.media_assets asset
      ${UPLOADER_JOINS}
      where asset.folder_id = folder.id and ${confirmedOf}
      order by asset.created_at desc, asset.id desc
      limit 1
    ) newest on true
    where folder.client_id = ?::uuid
    order by folder.depth, folder.is_default desc, ${foldTextSql('folder.name')} collate "C", folder.id
    limit ? offset ?
  `, [clientId, MEDIA_FOLDER_IN_USE_WINDOW_DAYS, clientId, page.limit, page.offset]);
  if (result.rows.length > 0 || page.offset === 0) return { rows: result.rows, total: Number(result.rows[0]?.total ?? 0) };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.media_folders where client_id = ?::uuid
  `, [clientId]);
  return { rows: [], total: Number(count.rows[0]?.total ?? 0) };
};

/** Writes the name of a folder (the only column the grant gives). `false` when no row was written. */
export const renameFolder = async (transaction: Transaction, clientId: string, folderId: string, name: string): Promise<boolean> => {
  const result = await raw<RawRows<{ id: string }>>(transaction, `
    update public.media_folders set name = ? where id = ?::uuid and client_id = ?::uuid and not is_default returning id
  `, [name, folderId, clientId]);
  return result.rows.length > 0;
};
