import { PORTAL_MATERIAL_UPLOAD_TYPES, type PortalMaterialUploadCategory, type PortalMaterialUploadContentType } from '@ageniza/contracts';
import { raw } from '@ageniza/database';

import { objectKeyFor, uploadObjectKeyFor } from './policy.js';
import { portalRequestNotFound, portalRequestResolved, translatePortalUploadError } from './portal-upload-errors.js';

type Transaction = Parameters<typeof raw>[0];

interface RawRows<TResult> {
  readonly rows: readonly TResult[];
}

/** What the database hands the API to run the three functions that write: the defaults of the deployment and the reservation window. */
export interface PortalUploadSettings {
  readonly quotaDefaultBytes: number;
  readonly quotaDefaultObjectCount: number;
  readonly reservationSeconds: number;
}

export interface StartedPortalUpload {
  readonly assetId: string;
  readonly agencyId: string;
  readonly category: PortalMaterialUploadCategory;
  readonly contentType: string;
  readonly uploadObjectKey: string;
}

export const startPortalUpload = async (
  transaction: Transaction,
  input: {
    readonly clientId: string;
    readonly threadId: string;
    readonly contentType: string;
    readonly declaredSizeBytes: number;
    readonly fileName: string;
    readonly settings: PortalUploadSettings;
  }
): Promise<StartedPortalUpload> => {
  const result = await raw<RawRows<{
    asset_id: string;
    agency_id: string;
    category: PortalMaterialUploadCategory;
    content_type: string;
    upload_object_key: string;
  }>>(transaction, `
    select asset_id, agency_id, category, content_type, upload_object_key
    from app_private.start_portal_material_upload(?::uuid, ?::uuid, ?::text, ?::bigint, ?::text, ?::bigint, ?::bigint, ?::integer)
  `, [
    input.clientId, input.threadId, input.contentType, input.declaredSizeBytes, input.fileName,
    input.settings.quotaDefaultBytes, input.settings.quotaDefaultObjectCount, input.settings.reservationSeconds
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('start_portal_material_upload returned no row.');
  return { assetId: row.asset_id, agencyId: row.agency_id, category: row.category, contentType: row.content_type, uploadObjectKey: row.upload_object_key };
};

export type PortalUploadVerdict =
  | { readonly outcome: 'confirmed' }
  | { readonly outcome: 'rejected'; readonly reason: string };

/** The bytes were read: the database says `confirmed`, or records and answers the refusal. */
export const confirmPortalUpload = async (
  transaction: Transaction,
  input: {
    readonly assetId: string;
    readonly sizeBytes: number;
    readonly contentType: string;
    readonly dimensions: { readonly width: number; readonly height: number } | undefined;
    readonly settings: PortalUploadSettings;
  }
): Promise<PortalUploadVerdict> => {
  const result = await raw<RawRows<{ outcome: 'confirmed' | 'rejected'; reason: string | null }>>(transaction, `
    select outcome, reason
    from app_private.confirm_portal_material_upload(?::uuid, ?::bigint, ?::text, ?::integer, ?::integer, ?::bigint, ?::bigint, ?::integer)
  `, [
    input.assetId, input.sizeBytes, input.contentType, input.dimensions?.width ?? null, input.dimensions?.height ?? null,
    input.settings.quotaDefaultBytes, input.settings.quotaDefaultObjectCount, input.settings.reservationSeconds
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('confirm_portal_material_upload returned no row.');
  if (row.outcome === 'confirmed') return { outcome: 'confirmed' };
  if (row.reason === null) throw new Error('confirm_portal_material_upload rejected without a reason.');
  return { outcome: 'rejected', reason: row.reason };
};

/** The person lets go of her own reservation: the object never came, or the API turned it down. */
export const rejectPortalUpload = async (transaction: Transaction, assetId: string, reason: string): Promise<void> => {
  await raw(transaction, 'select app_private.reject_portal_material_upload(?::uuid, ?::text)', [assetId, reason]);
};

export interface PortalUploadRow {
  readonly asset_id: string;
  readonly status: 'pending' | 'confirmed';
  readonly category: PortalMaterialUploadCategory;
  readonly content_type: string;
  readonly size_bytes: string | number;
  readonly file_name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly created_at: Date;
  readonly object_key: string | null;
}

interface PortalUploadPageRow extends Omit<PortalUploadRow, 'asset_id'> {
  readonly total_count: string | number;
  readonly asset_id: string | null;
}

// A position past the largest one the database takes (a bigint) is a page past the end, never an error.
const MAX_OFFSET = Number.MAX_SAFE_INTEGER;

/** `list_portal_material_uploads`: the one read of the portal. A page past the end, and a request with no file, come back as the total alone. */
export const listPortalUploadsPage = async (
  transaction: Transaction,
  input: { readonly clientId: string; readonly threadId: string; readonly limit: number; readonly offset: number }
): Promise<{ readonly rows: readonly PortalUploadRow[]; readonly total: number }> => {
  const result = await raw<RawRows<PortalUploadPageRow>>(transaction, `
    select total_count, asset_id, status, category, content_type, size_bytes, file_name, width, height, created_at, object_key
    from app_private.list_portal_material_uploads(?::uuid, ?::uuid, ?::integer, ?::bigint)
  `, [input.clientId, input.threadId, input.limit, Math.min(input.offset, MAX_OFFSET)]);
  const first = result.rows[0];
  const rows = result.rows.flatMap((row): PortalUploadRow[] => (row.asset_id === null ? [] : [{ ...row, asset_id: row.asset_id }]));
  return { rows, total: first === undefined ? 0 : Number(first.total_count) };
};

const ALL_FILES_PAGE = 100;

/**
 * Every file the person sent to the request, by pages of the database's ceiling. A request takes twenty files, but a reservation that
 * expired stays on the list, so one page is not a promise.
 */
export const listAllOwnPortalUploads = async (
  transaction: Transaction,
  input: { readonly clientId: string; readonly threadId: string }
): Promise<readonly PortalUploadRow[]> => {
  const files: PortalUploadRow[] = [];
  for (let offset = 0; ; offset += ALL_FILES_PAGE) {
    const page = await listPortalUploadsPage(transaction, { ...input, limit: ALL_FILES_PAGE, offset });
    files.push(...page.rows);
    if (offset + ALL_FILES_PAGE >= page.total) return files;
  }
};

export const portalUploadExtension = (contentType: string): string => {
  if (!Object.hasOwn(PORTAL_MATERIAL_UPLOAD_TYPES, contentType)) throw new Error('The database answered a type the portal does not take.');
  return PORTAL_MATERIAL_UPLOAD_TYPES[contentType as PortalMaterialUploadContentType].extension;
};

/**
 * The two keys of a portal upload that the person's own list does not carry (it hands the final one only for a confirmed file, and the
 * staging one never). They are the agency's keys, `objectKeyFor` and `uploadObjectKeyFor`, from the agency of the client and the
 * extension of the declared type; the integration test compares them with what the database wrote.
 */
export const portalUploadKeys = (agencyId: string, assetId: string, contentType: string): { readonly canonicalKey: string; readonly stagingKey: string } => {
  const extension = portalUploadExtension(contentType);
  return { canonicalKey: objectKeyFor(agencyId, assetId, extension), stagingKey: uploadObjectKeyFor(agencyId, assetId, extension) };
};

/**
 * One completion at a time per file. The database locks the row only when it confirms, after the bytes were read, so without this two
 * completions of the same file could copy two different staging objects over the one canonical key between the verdict and the
 * confirmation. Taken only after the file was proven the person's own, and always before the locks of the database.
 */
export const lockPortalUploadCompletion = async (transaction: Transaction, assetId: string): Promise<void> => {
  await raw(transaction, 'select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended((\'portal-upload-completion:\' || (?::uuid)::text), 0))', [assetId]);
};

/** What the clients module is handed to check and word an announcement: the files the person confirmed in a request, and the refusals' answers. */
export const portalUploadsForClients = {
  listOwnUploads: async (transaction: Transaction, input: { readonly clientId: string; readonly threadId: string }) =>
    (await listAllOwnPortalUploads(transaction, input)).map((row) => ({ id: row.asset_id, status: row.status, category: row.category })),
  translateError: translatePortalUploadError,
  requestNotFound: portalRequestNotFound,
  requestResolved: portalRequestResolved
};
