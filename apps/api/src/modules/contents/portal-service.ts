import type { PortalContentDetail, PortalContentInProduction, PortalContentListItem, PortalContentOpenListItem } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { ContentTransaction } from './service.js';

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

type SqlBinding = string | number | null;

export interface PortalContentRow {
  readonly id: string;
  readonly title: string;
  readonly platform: 'instagram';
  readonly format: PortalContentListItem['format'];
  readonly publish_on: string;
  readonly status: 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published';
  readonly revision: number | null;
  readonly publish_at_time: string | null;
  readonly caption: string | null;
  readonly cover_asset_id: string | null;
  readonly thumbnail_asset_id: string | null;
  readonly published_on: string | null;
}

/*
 * Every read of the portal goes through `app_private.portal_contents` and `app_private.portal_content_media`
 * (migration 20261007001200): `security definer` functions that answer for the person's active link to the client and
 * for nobody else. The portal has no policy on `contents`, and a person who is also a collaborator reads a content in
 * production with its caption through the agency branch of the policy, so the cut of the portal is written in the
 * function and the route never selects from the table. The function leaves a cancelled content out and nulls every column
 * but the title, the day and the format while the content is in production.
 */

// Days are read as text and the time as HH:MM: the driver would turn a `date` into an instant in the server's zone.
const PORTAL_COLUMNS = `
  content.id, content.title, content.platform, content.format, content.publish_on::text as publish_on, content.status,
  content.revision, to_char(content.publish_at_time, 'HH24:MI') as publish_at_time, content.caption, content.cover_asset_id,
  content.published_on::text as published_on,
  (
    select media.asset_id
    from app_private.portal_content_media(content.id) media
    order by (media.role = 'media'), media.item_position, media.asset_id
    limit 1
  ) as thumbnail_asset_id
`;

// A content without an hour comes last in a day: an ascending order puts the null after every hour.
const PORTAL_ORDER = 'order by content.publish_on, content.publish_at_time, content.id';

/** The contents of the client whose day is inside the period, oldest day first; one more row than the ceiling is asked for. */
export const listPortalContents = async (
  transaction: ContentTransaction,
  clientId: string,
  period: { readonly from: string; readonly to: string },
  limit: number
): Promise<PortalContentRow[]> => {
  const result = await raw<RawRows<PortalContentRow>>(transaction, `
    select ${PORTAL_COLUMNS}
    from app_private.portal_contents(?::uuid, ?::date, ?::date, null::text[], null::uuid) content
    ${PORTAL_ORDER}
    limit ?
  `, [clientId, period.from, period.to, limit]);
  return [...result.rows];
};

export interface AwaitingPage {
  readonly items: readonly PortalContentRow[];
  readonly totalItems: number;
}

const AWAITING_FROM = `from app_private.portal_contents(?::uuid, null::date, null::date, array['awaiting_approval']::text[], null::uuid) content`;

/** What waits for the person: the contents awaiting approval, the nearest day first. `count(*) over ()` rides the page's own snapshot. */
export const listAwaitingContents = async (
  transaction: ContentTransaction,
  clientId: string,
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<AwaitingPage> => {
  const result = await raw<RawRows<PortalContentRow & { readonly total: string | number }>>(transaction, `
    select ${PORTAL_COLUMNS}, count(*) over () as total
    ${AWAITING_FROM}
    ${PORTAL_ORDER}
    limit ? offset ?
  `, [clientId, pagination.pageSize, pagination.offset]);
  if (result.rows.length > 0) return { items: result.rows, totalItems: Number(result.rows[0]?.total ?? 0) };
  // An empty first page is the whole truth; a page past the end still owes the real total, read by a second count.
  if (pagination.offset === 0) return { items: [], totalItems: 0 };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `select count(*) as total ${AWAITING_FROM}`, [clientId]);
  return { items: [], totalItems: Number(count.rows[0]?.total ?? 0) };
};

/** One content of THIS client as the portal reads it: another client's, a cancelled one and an absent one are all `undefined`. */
export const loadPortalContent = async (
  transaction: ContentTransaction,
  clientId: string,
  contentId: string
): Promise<PortalContentRow | undefined> => {
  const bindings: SqlBinding[] = [clientId, contentId];
  const result = await raw<RawRows<PortalContentRow>>(transaction, `
    select ${PORTAL_COLUMNS}
    from app_private.portal_contents(?::uuid, null::date, null::date, null::text[], ?::uuid) content
  `, bindings);
  return result.rows[0];
};

/** The media of the post, in order. The cover is the content's `coverAssetId`, not an item of the list. */
const loadPortalMedia = async (transaction: ContentTransaction, contentId: string): Promise<Array<{ id: string; position: number; kind: 'image' | 'video' }>> => {
  const result = await raw<RawRows<{ asset_id: string; item_position: number; category: 'image' | 'video' }>>(transaction, `
    select media.asset_id, media.item_position, media.category
    from app_private.portal_content_media(?::uuid) media
    where media.role = 'media'
    order by media.item_position, media.asset_id
  `, [contentId]);
  return result.rows.map((row) => ({ id: row.asset_id, position: row.item_position, kind: row.category }));
};

export interface PortalMediaAsset {
  readonly assetId: string;
  readonly category: 'image' | 'video';
  readonly extension: string;
  readonly videoProcessingStatus: string;
  readonly thumbnailObjectKey: string | null;
}

/**
 * One file of THIS content as the portal reads it, the cover or an item of the media. The function answers only for a content open
 * to the person, and leaves out a file that is removed or not confirmed, so everything else is `undefined`.
 */
export const loadPortalMediaAsset = async (
  transaction: ContentTransaction,
  contentId: string,
  assetId: string
): Promise<PortalMediaAsset | undefined> => {
  const result = await raw<RawRows<{
    asset_id: string;
    category: PortalMediaAsset['category'];
    extension: string;
    video_processing_status: string;
    thumbnail_object_key: string | null;
  }>>(transaction, `
    select media.asset_id, media.category, media.extension, media.video_processing_status, media.thumbnail_object_key
    from app_private.portal_content_media(?::uuid) media
    where media.asset_id = ?::uuid
    limit 1
  `, [contentId, assetId]);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    assetId: row.asset_id,
    category: row.category,
    extension: row.extension,
    videoProcessingStatus: row.video_processing_status,
    thumbnailObjectKey: row.thumbnail_object_key
  };
};

/** A content in production is the title, the day and the format: the projection is the second barrier after the function's own cut. */
const inProductionFrom = (row: PortalContentRow & { readonly status: 'in_production' }): PortalContentInProduction => ({
  id: row.id,
  title: row.title,
  format: row.format,
  publishOn: row.publish_on,
  status: row.status
});

const openDetailBaseFrom = (row: PortalContentRow & { readonly status: PortalContentOpenListItem['status'] }): Omit<PortalContentOpenListItem, 'thumbnailAssetId'> => ({
  id: row.id,
  title: row.title,
  platform: row.platform,
  format: row.format,
  publishOn: row.publish_on,
  publishAtTime: row.publish_at_time,
  status: row.status,
  coverAssetId: row.cover_asset_id,
  publishedOn: row.published_on
});

/** `thumbnailAssetId` is the file that serves as the cover of the card: the function's first row, the chosen cover before the media. */
export const openListItemFrom = (row: PortalContentRow & { readonly status: PortalContentOpenListItem['status'] }): PortalContentOpenListItem => ({
  ...openDetailBaseFrom(row),
  thumbnailAssetId: row.thumbnail_asset_id
});

export const listItemFrom = (row: PortalContentRow): PortalContentListItem =>
  row.status === 'in_production' ? inProductionFrom({ ...row, status: row.status }) : openListItemFrom({ ...row, status: row.status });

export const detailFrom = async (transaction: ContentTransaction, row: PortalContentRow): Promise<PortalContentDetail> => {
  if (row.status === 'in_production') return inProductionFrom({ ...row, status: row.status });
  if (row.revision === null) throw new Error('A content open to the client reached the portal without a revision.');
  return {
    ...openDetailBaseFrom({ ...row, status: row.status }),
    caption: row.caption,
    revision: row.revision,
    media: await loadPortalMedia(transaction, row.id)
  };
};

/** `app_private.approve_content`: only an active person of the client's portal; idempotent, the first person to approve stays. */
export const approveContent = async (transaction: ContentTransaction, input: { readonly contentId: string; readonly revision: number }): Promise<void> => {
  await raw(transaction, 'select app_private.approve_content(?::uuid, ?::integer)', [input.contentId, input.revision]);
};

/**
 * `app_private.request_content_changes`: opens (or finds) the conversation of the content, writes the comment as the client and moves
 * the content to "in adjustment", in one transaction; a comment that is refused leaves neither a conversation nor a state behind.
 */
export const requestContentChanges = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly revision: number; readonly comment: string }
): Promise<void> => {
  await raw(transaction, 'select app_private.request_content_changes(?::uuid, ?::integer, ?)', [input.contentId, input.revision, input.comment]);
};

/** Whether the person still has an active link to this client of an active agency: what the portal guard proved. */
export const portalAccessHolds = async (transaction: ContentTransaction, clientId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ allowed: boolean }>>(transaction, 'select app_private.is_client_member(?::uuid) as allowed', [clientId]);
  return result.rows[0]?.allowed === true;
};
