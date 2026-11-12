import type { PortalContentApproval, PortalContentDetail, PortalContentInProduction, PortalContentListItem, PortalContentOpenListItem } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { CLOCK_CTES } from './clock-sql.js';
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
  /** The function answers a round only for a content that left production; `has_approval` is false for one with no round (sent before the rounds existed). */
  readonly has_approval: boolean;
  readonly approval_due_on: string | null;
  readonly approval_note: string | null;
  readonly approval_due_at: Date | null;
  readonly approval_sent_at: Date | null;
  readonly approval_sent_by_name: string | null;
  readonly approval_sent_by_photo_key: string | null;
}

/** The signed address of each sender photo of a page, by the key the account stores: the route signs the keys once, the mapping reads them. */
export type SenderPhotoUrls = ReadonlyMap<string, string | null>;

/** The columns of a round the approval link also reads, and the ones only the person's own portal reads: a row without them is a round that says less. */
type ApprovalRow = Pick<PortalContentRow, 'has_approval' | 'approval_due_on' | 'approval_note'>
  & Partial<Pick<PortalContentRow, 'approval_due_at' | 'approval_sent_at' | 'approval_sent_by_name' | 'approval_sent_by_photo_key'>>;

const instantOf = (value: Date | null | undefined): string | null => value === null || value === undefined ? null : new Date(value).toISOString();

/**
 * What the agency asked of the client and who asked (decision 2026-11-11): the deadline as an instant and as its day, the note, when it was
 * sent and the sender as a name and a photo. The batch, the e-mail, the role and the id of the sender never reach the portal. The approval
 * link reads fewer columns of the same round: its answer has the day and the note, and the rest `null`.
 */
export const portalApprovalOf = (row: ApprovalRow, senderPhotos: SenderPhotoUrls = new Map()): PortalContentApproval | null => {
  if (!row.has_approval) return null;
  const photoKey = row.approval_sent_by_photo_key ?? null;
  return {
    dueAt: instantOf(row.approval_due_at),
    dueOn: row.approval_due_on,
    note: row.approval_note,
    sentAt: instantOf(row.approval_sent_at),
    sentBy: row.approval_sent_by_name == null ? null : { name: row.approval_sent_by_name, photoUrl: photoKey === null ? null : senderPhotos.get(photoKey) ?? null }
  };
};

/** The keys of the sender photos a page of rows needs signed, each once. */
export const senderPhotoKeysOf = (rows: ReadonlyArray<Pick<PortalContentRow, 'has_approval' | 'approval_sent_by_photo_key'>>): string[] =>
  [...new Set(rows.flatMap((row) => row.has_approval && row.approval_sent_by_photo_key !== null ? [row.approval_sent_by_photo_key] : []))];

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
  (content.approval_sent_at is not null) as has_approval, content.approval_due_on::text as approval_due_on, content.approval_note,
  content.approval_due_at, content.approval_sent_at, content.approval_sent_by_name, content.approval_sent_by_photo_key,
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

// What the person answers first is what is due first (decision 2026-11-11): the deadline of the approval, with its hour; a content with no
// deadline (sent before the rounds) comes after every deadline, in the order of the calendar.
const AWAITING_ORDER = 'order by content.approval_due_at asc nulls last, content.publish_on, content.publish_at_time, content.id';

/** What waits for the person: the contents awaiting approval, the deadline that comes first first. `count(*) over ()` rides the page's own snapshot. */
export const listAwaitingContents = async (
  transaction: ContentTransaction,
  clientId: string,
  pagination: { readonly pageSize: number; readonly offset: number }
): Promise<AwaitingPage> => {
  const result = await raw<RawRows<PortalContentRow & { readonly total: string | number }>>(transaction, `
    select ${PORTAL_COLUMNS}, count(*) over () as total
    ${AWAITING_FROM}
    ${AWAITING_ORDER}
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

const openDetailBaseFrom = (
  row: PortalContentRow & { readonly status: PortalContentOpenListItem['status'] },
  senderPhotos: SenderPhotoUrls
): Omit<PortalContentOpenListItem, 'thumbnailAssetId'> => ({
  id: row.id,
  title: row.title,
  platform: row.platform,
  format: row.format,
  publishOn: row.publish_on,
  publishAtTime: row.publish_at_time,
  status: row.status,
  coverAssetId: row.cover_asset_id,
  publishedOn: row.published_on,
  approval: portalApprovalOf(row, senderPhotos)
});

/** `thumbnailAssetId` is the file that serves as the cover of the card: the function's first row, the chosen cover before the media. */
export const openListItemFrom = (
  row: PortalContentRow & { readonly status: PortalContentOpenListItem['status'] },
  senderPhotos: SenderPhotoUrls = new Map()
): PortalContentOpenListItem => ({
  ...openDetailBaseFrom(row, senderPhotos),
  thumbnailAssetId: row.thumbnail_asset_id
});

export const listItemFrom = (row: PortalContentRow, senderPhotos: SenderPhotoUrls = new Map()): PortalContentListItem =>
  row.status === 'in_production' ? inProductionFrom({ ...row, status: row.status }) : openListItemFrom({ ...row, status: row.status }, senderPhotos);

export const detailFrom = async (transaction: ContentTransaction, row: PortalContentRow, senderPhotos: SenderPhotoUrls = new Map()): Promise<PortalContentDetail> => {
  if (row.status === 'in_production') return inProductionFrom({ ...row, status: row.status });
  if (row.revision === null) throw new Error('A content open to the client reached the portal without a revision.');
  return {
    ...openDetailBaseFrom({ ...row, status: row.status }, senderPhotos),
    caption: row.caption,
    revision: row.revision,
    media: await loadPortalMedia(transaction, row.id)
  };
};

/**
 * `app_private.approve_content`: only an active person of the client's portal; idempotent, the first person to approve stays. The note,
 * when there is one, enters the conversation of the content as a comment of the client in the same transaction as the approval: the
 * function judges it (500 visible characters, like the note of the agency) after the door and writes it, or the approval is undone.
 */
export const approveContent = async (
  transaction: ContentTransaction,
  input: { readonly contentId: string; readonly revision: number; readonly note?: string | undefined }
): Promise<void> => {
  await raw(transaction, 'select app_private.approve_content(?::uuid, ?::integer, ?::text)', [input.contentId, input.revision, input.note ?? null]);
};

export interface PortalProgress {
  readonly month: string;
  readonly approved: number;
  readonly total: number;
  readonly next: { readonly id: string; readonly title: string; readonly publishOn: string; readonly publishAtTime: string | null } | null;
}

/**
 * "Boa notícia" of the portal's Início (decision 2026-11-11): of the contents of the month of today in São Paulo that are not cancelled
 * (the function leaves the cancelled out), how many are approved or published; and the next post to go on air, the earliest approved
 * content whose day has not passed and, when it has an hour, whose hour has not. Both come from `portal_contents`, the one door of the
 * portal to a content, so the count is of what this person reads and of nothing else.
 */
export const loadPortalProgress = async (
  transaction: ContentTransaction,
  input: { readonly clientId: string; readonly now: Date | undefined }
): Promise<PortalProgress> => {
  const result = await raw<RawRows<{
    month: string;
    approved: string | number;
    total: string | number;
    next_id: string | null;
    next_title: string | null;
    next_publish_on: string | null;
    next_publish_at_time: string | null;
  }>>(transaction, `
    with ${CLOCK_CTES},
    month_rows as (
      select content.status
      from clock, app_private.portal_contents(?::uuid, clock.month_start, clock.next_month_start - 1, null::text[], null::uuid) content
    )
    select to_char(clock.month_start, 'YYYY-MM') as month,
      (select count(*) filter (where month_rows.status in ('approved', 'published')) from month_rows) as approved,
      (select count(*) from month_rows) as total,
      upcoming.id as next_id, upcoming.title as next_title, upcoming.publish_on as next_publish_on, upcoming.publish_at_time as next_publish_at_time
    from clock
    left join lateral (
      select content.id, content.title, content.publish_on::text as publish_on, to_char(content.publish_at_time, 'HH24:MI') as publish_at_time
      from app_private.portal_contents(?::uuid, clock.today, null::date, array['approved']::text[], null::uuid) content
      where content.publish_on > clock.today or content.publish_at_time is null or content.publish_at_time > clock.local_time
      order by content.publish_on, content.publish_at_time, content.id
      limit 1
    ) upcoming on true
  `, [input.now?.toISOString() ?? null, input.clientId, input.clientId]);

  const row = result.rows[0];
  if (row === undefined) throw new Error('The progress of the month returned no row.');
  return {
    month: row.month,
    approved: Number(row.approved),
    total: Number(row.total),
    next: row.next_id === null || row.next_title === null || row.next_publish_on === null
      ? null
      : { id: row.next_id, title: row.next_title, publishOn: row.next_publish_on, publishAtTime: row.next_publish_at_time }
  };
};

export const withdrawContentApproval = async (transaction: ContentTransaction, input: { readonly contentId: string; readonly revision: number }): Promise<void> => {
  await raw(transaction, 'select app_private.withdraw_content_approval(?::uuid, ?::integer)', [input.contentId, input.revision]);
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
