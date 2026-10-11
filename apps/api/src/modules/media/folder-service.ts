import { raw } from '@ageniza/database';

import { foldTextSql } from '../../plugins/infra/sql-text.js';

type Transaction = Parameters<typeof raw>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

export interface FolderRow {
  readonly id: string;
  readonly client_id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly is_default: boolean;
  readonly created_at: Date;
}

export interface FolderAssetRow {
  readonly id: string;
  readonly category: 'image' | 'video';
  readonly confirmed_content_type: string;
  readonly confirmed_size_bytes: string | number;
  readonly video_processing_status: 'not_applicable' | 'pending' | 'processing' | 'ready' | 'failed';
  readonly created_at: Date;
  readonly total: string | number;
}

export type ClientScope = 'not-found' | 'archived' | 'active';

/**
 * Whether the client is this agency's, and open to writes. It reads through the helpers the policies use,
 * so a role that holds only `conteudo.*` (and cannot read `clients`) is judged like any other, and another
 * agency's client is the same answer as an absent one.
 */
export const clientScopeOf = async (transaction: Transaction, agencyId: string, clientId: string): Promise<ClientScope> => {
  const result = await raw<RawRows<{ agency_id: string | null; active: boolean }>>(transaction, `
    select app_private.client_agency_id(?::uuid) as agency_id, app_private.client_is_active(?::uuid) as active
  `, [clientId, clientId]);
  const row = result.rows[0];
  if (row === undefined || row.agency_id !== agencyId) return 'not-found';
  return row.active ? 'active' : 'archived';
};

export const loadFolder = async (transaction: Transaction, clientId: string, folderId: string): Promise<FolderRow | undefined> => {
  const result = await raw<RawRows<FolderRow>>(transaction, `
    select id, client_id, parent_id, name, is_default, created_at
    from public.media_folders
    where id = ?::uuid and client_id = ?::uuid
  `, [folderId, clientId]);
  return result.rows[0];
};

/** `app_private.lock_media_folder`: unknown, foreign and unauthorized folders all raise `A0080`. */
export const lockFolder = async (transaction: Transaction, folderId: string): Promise<FolderRow> => {
  const result = await raw<RawRows<FolderRow>>(transaction, `
    select id, client_id, parent_id, name, is_default, created_at from app_private.lock_media_folder(?::uuid)
  `, [folderId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('lock_media_folder returned no row.');
  return row;
};

/**
 * One page of the folders of a client: the first level before the working folders, the default ones first, then
 * by name (accent and case folded, then compared byte by byte like the collaborators and the people of a client,
 * so the order does not depend on the database collation), with the id as the tie-break. `count(*) over ()` rides
 * the page's own snapshot; a page past the end has no row to carry it, so the total is counted on its own.
 */
export const listFolders = async (
  transaction: Transaction,
  clientId: string,
  page: { readonly limit: number; readonly offset: number }
): Promise<{ readonly rows: readonly FolderRow[]; readonly total: number }> => {
  const result = await raw<RawRows<FolderRow & { total: string | number }>>(transaction, `
    select id, client_id, parent_id, name, is_default, created_at, count(*) over () as total
    from public.media_folders
    where client_id = ?::uuid
    order by depth, is_default desc, ${foldTextSql('name')} collate "C", id
    limit ? offset ?
  `, [clientId, page.limit, page.offset]);
  if (result.rows.length > 0 || page.offset === 0) return { rows: result.rows, total: Number(result.rows[0]?.total ?? 0) };

  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.media_folders where client_id = ?::uuid
  `, [clientId]);
  return { rows: [], total: Number(count.rows[0]?.total ?? 0) };
};

export const insertFolder = async (
  transaction: Transaction,
  input: { readonly clientId: string; readonly parentId: string | null; readonly name: string }
): Promise<FolderRow> => {
  const result = await raw<RawRows<FolderRow>>(transaction, `
    insert into public.media_folders (client_id, parent_id, name)
    values (?::uuid, ?::uuid, ?)
    returning id, client_id, parent_id, name, is_default, created_at
  `, [input.clientId, input.parentId, input.name]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('The folder that was just inserted could not be read back.');
  return row;
};

/** Confirmed and not removed: a pending or rejected upload is not yet a media of the folder. */
export const listFolderAssets = async (
  transaction: Transaction,
  folderId: string,
  page: { readonly limit: number; readonly offset: number }
): Promise<{ readonly rows: readonly FolderAssetRow[]; readonly total: number }> => {
  const result = await raw<RawRows<FolderAssetRow>>(transaction, `
    select id, category, confirmed_content_type, confirmed_size_bytes, video_processing_status, created_at,
      count(*) over () as total
    from public.media_assets
    where folder_id = ?::uuid and status = 'confirmed' and removed_at is null
    order by created_at desc, id desc
    limit ? offset ?
  `, [folderId, page.limit, page.offset]);
  if (result.rows.length > 0 || page.offset === 0) return { rows: result.rows, total: Number(result.rows[0]?.total ?? 0) };

  // A page past the end carries no row, and "no total" would read as an empty folder.
  const count = await raw<RawRows<{ total: string | number }>>(transaction, `
    select count(*) as total from public.media_assets
    where folder_id = ?::uuid and status = 'confirmed' and removed_at is null
  `, [folderId]);
  return { rows: [], total: Number(count.rows[0]?.total ?? 0) };
};

/**
 * Takes the media out of its folder. Resolves `true` when THIS call removed it and `false` when it was already
 * removed, as the function sees it after the lock of the media: that is the only point where two removals at
 * the same instant are told apart, so the audit event is decided by it and never by a read before the lock.
 */
export const removeAsset = async (transaction: Transaction, assetId: string, folderId: string): Promise<boolean> => {
  const result = await raw<RawRows<{ removed: boolean }>>(
    transaction,
    'select app_private.remove_media_asset(?::uuid, ?::uuid) as removed',
    [assetId, folderId]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('remove_media_asset returned no row.');
  return row.removed;
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

/** What the functions of 20261007001500 and the gate on the client raise, as the API's refusals. */
export const folderFunctionRefusal = (error: unknown): 'not-found' | 'client-archived' | 'in-use' | undefined => {
  switch (databaseCode(error)) {
    case 'A0080': return 'not-found';
    case 'A0020':
    case 'A0081': return 'client-archived';
    case 'A0082': return 'in-use';
    default: return undefined;
  }
};

/** A parent that is not a first-level folder of the same client breaks the composite foreign key. */
export const isFolderParentViolation = (error: unknown): boolean =>
  databaseCode(error) === '23503' && (error as { constraint?: unknown }).constraint === 'media_folders_parent_fk';
