import type { PortalApprovalBatch, PortalApprovalContent } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import type { ContentTransaction } from '../contents/service.js';

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/*
 * Everything the link reads or writes goes through the functions of migration 20261027090200 (`portal_approval_*`,
 * `approve_content_by_portal_approval`, `request_changes_by_portal_approval`): `security definer` functions that answer for a session
 * of the approval link and for nobody else, with no account in the transaction. The tables of the link have no grant for the
 * application role, and every function judges the revocation again (access, generation, client, agency, plan) before it answers.
 */

export interface ExchangedSession {
  readonly sessionExpiresAt: Date;
  readonly linkExpiresAt: Date;
}

/** The token (by its hash) for a session (by its hash). */
export const exchangeApprovalToken = async (transaction: ContentTransaction, tokenHash: string, sessionHash: string): Promise<ExchangedSession> => {
  const result = await raw<RawRows<{ session_expires_at: Date; link_expires_at: Date }>>(
    transaction, 'select session_expires_at, link_expires_at from app_private.exchange_portal_approval_token(?, ?)', [tokenHash, sessionHash]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The exchange of an approval token returned no session.');
  return { sessionExpiresAt: row.session_expires_at, linkExpiresAt: row.link_expires_at };
};

interface BatchHeaderRow {
  readonly client_name: string;
  readonly agency_name: string;
  readonly agency_id: string;
  readonly person_email: string;
  readonly link_expires_at: Date;
  readonly session_expires_at: Date;
}

interface ContentRow {
  readonly id: string;
  readonly title: string;
  readonly platform: 'instagram';
  readonly format: PortalApprovalContent['format'];
  readonly publish_on: string;
  readonly status: 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published';
  readonly revision: number | null;
  readonly publish_at_time: string | null;
  readonly caption: string | null;
  readonly cover_asset_id: string | null;
  readonly published_on: string | null;
}

interface MediaRow {
  readonly content_id: string;
  readonly asset_id: string;
  readonly role: 'cover' | 'media';
  readonly item_position: number;
  readonly category: 'image' | 'video';
  readonly extension: string;
  readonly video_processing_status: string;
  readonly thumbnail_object_key: string | null;
}

// Days are read as text and the time as HH:MM: the driver would turn a `date` into an instant in the server's zone.
const CONTENT_COLUMNS = `
  id, title, platform, format, publish_on::text as publish_on, status, revision, to_char(publish_at_time, 'HH24:MI') as publish_at_time,
  caption, cover_asset_id, published_on::text as published_on
`;

export const loadBatchHeader = async (transaction: ContentTransaction, sessionHash: string): Promise<BatchHeaderRow> => {
  const result = await raw<RawRows<BatchHeaderRow>>(transaction, 'select * from app_private.portal_approval_batch(?)', [sessionHash]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('A live approval session returned no batch.');
  return row;
};

export const loadBatchContents = async (transaction: ContentTransaction, sessionHash: string): Promise<ContentRow[]> => {
  const result = await raw<RawRows<ContentRow>>(transaction, `select ${CONTENT_COLUMNS} from app_private.portal_approval_contents(?)`, [sessionHash]);
  return [...result.rows];
};

export const loadBatchMedia = async (transaction: ContentTransaction, sessionHash: string): Promise<MediaRow[]> => {
  const result = await raw<RawRows<MediaRow>>(
    transaction,
    `select content_id, asset_id, role, item_position, category, extension, video_processing_status, thumbnail_object_key
     from app_private.portal_approval_media(?)`,
    [sessionHash]
  );
  return [...result.rows];
};

/** The media of the post, in order. The cover is the content's `coverAssetId`, not an item of the list. */
const mediaOf = (media: readonly MediaRow[], contentId: string): Array<{ id: string; position: number; kind: 'image' | 'video' }> =>
  media
    .filter((row) => row.content_id === contentId && row.role === 'media')
    .sort((left, right) => left.item_position - right.item_position || left.asset_id.localeCompare(right.asset_id))
    .map((row) => ({ id: row.asset_id, position: row.item_position, kind: row.category }));

/** `canDecide` is the state of the content now: the buttons exist only for a content awaiting approval. */
export const contentFrom = (row: ContentRow, media: readonly MediaRow[]): PortalApprovalContent => {
  if (row.status === 'in_production') {
    return { id: row.id, title: row.title, format: row.format, publishOn: row.publish_on, status: row.status, canDecide: false };
  }
  if (row.revision === null) throw new Error('A content open to the client reached the approval link without a revision.');
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    format: row.format,
    publishOn: row.publish_on,
    publishAtTime: row.publish_at_time,
    status: row.status,
    coverAssetId: row.cover_asset_id,
    publishedOn: row.published_on,
    caption: row.caption,
    revision: row.revision,
    media: mediaOf(media, row.id),
    canDecide: row.status === 'awaiting_approval'
  };
};

export const loadBatch = async (transaction: ContentTransaction, sessionHash: string): Promise<{ batch: PortalApprovalBatch; agencyId: string }> => {
  const header = await loadBatchHeader(transaction, sessionHash);
  const contents = await loadBatchContents(transaction, sessionHash);
  const media = await loadBatchMedia(transaction, sessionHash);
  return {
    agencyId: header.agency_id,
    batch: {
      clientName: header.client_name,
      agencyName: header.agency_name,
      personEmail: header.person_email,
      sessionExpiresAt: header.session_expires_at.toISOString(),
      linkExpiresAt: header.link_expires_at.toISOString(),
      contents: contents.map((row) => contentFrom(row, media))
    }
  };
};

/** One content of the batch as the page reads it; `undefined` for anything outside the batch. */
export const loadBatchContent = async (transaction: ContentTransaction, sessionHash: string, contentId: string): Promise<PortalApprovalContent | undefined> => {
  const row = (await loadBatchContents(transaction, sessionHash)).find((candidate) => candidate.id === contentId);
  return row === undefined ? undefined : contentFrom(row, await loadBatchMedia(transaction, sessionHash));
};

/** `app_private.approve_content_by_portal_approval`: idempotent, the first approval stays. */
export const approveByLink = async (
  transaction: ContentTransaction,
  input: { readonly sessionHash: string; readonly contentId: string; readonly revision: number }
): Promise<void> => {
  await raw(transaction, 'select app_private.approve_content_by_portal_approval(?, ?::uuid, ?::integer)', [input.sessionHash, input.contentId, input.revision]);
};

/** `app_private.request_changes_by_portal_approval`: the conversation, the comment and the state in one transaction. */
export const requestChangesByLink = async (
  transaction: ContentTransaction,
  input: { readonly sessionHash: string; readonly contentId: string; readonly revision: number; readonly comment: string }
): Promise<void> => {
  await raw(
    transaction,
    'select app_private.request_changes_by_portal_approval(?, ?::uuid, ?::integer, ?)',
    [input.sessionHash, input.contentId, input.revision, input.comment]
  );
};

export interface BatchMediaAsset {
  readonly assetId: string;
  readonly category: 'image' | 'video';
  readonly extension: string;
  readonly videoProcessingStatus: string;
  readonly thumbnailObjectKey: string | null;
}

/** A file of the batch for the preview: `undefined` for a file of a content outside it, or one that is not shown (removed, unconfirmed). */
export const findBatchMediaAsset = (media: readonly MediaRow[], contentId: string, assetId: string): BatchMediaAsset | undefined => {
  const row = media.find((candidate) => candidate.content_id === contentId && candidate.asset_id === assetId);
  return row === undefined
    ? undefined
    : { assetId: row.asset_id, category: row.category, extension: row.extension, videoProcessingStatus: row.video_processing_status, thumbnailObjectKey: row.thumbnail_object_key };
};
