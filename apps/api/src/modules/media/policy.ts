import type { MediaCategory } from '@ageniza/contracts';

/** A fixed-window rate-limit policy, same shape as `../auth/policy.ts`. Upload URL emission is
 * rate-limited per issue #21 ("Rate limit na emissão de URLs de upload"). */
export interface MediaRateLimitWindow {
  readonly max: number;
  readonly windowMs: number;
}

/** Uploading is `midia.enviar` for the agency's own media and `conteudo.operar` for a client's; the route says which. */
export const MEDIA_UPLOAD_PERMISSIONS = ['midia.enviar', 'conteudo.operar'] as const;

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

export const MEDIA_RATE_LIMITS = {
  // Applies to every route that emits a signed URL: create-upload, request-parts, download-url.
  signedUrlIssuance: { max: 60, windowMs: FIFTEEN_MINUTES_MS }
} as const satisfies Readonly<Record<string, MediaRateLimitWindow>>;

/**
 * Content types this deployment accepts, mapped to a category and a fixed extension. The
 * extension never comes from client-supplied file names: object keys must never carry anything
 * resembling personal data (issue #21), and only a small fixed set of extensions is meaningful to
 * the worker that will later process these files (issue tracked separately).
 */
const CONTENT_TYPE_TABLE: Readonly<Record<string, { readonly category: MediaCategory; readonly extension: string }>> = {
  'image/png': { category: 'image', extension: 'png' },
  'image/jpeg': { category: 'image', extension: 'jpg' },
  'image/webp': { category: 'image', extension: 'webp' },
  'image/gif': { category: 'image', extension: 'gif' },
  'video/mp4': { category: 'video', extension: 'mp4' },
  'video/quicktime': { category: 'video', extension: 'mov' },
  'video/webm': { category: 'video', extension: 'webm' }
};

export interface MediaTypeDescriptor {
  readonly category: MediaCategory;
  readonly extension: string;
}

/** Returns `undefined` for any content type this deployment does not accept. */
export const describeMediaContentType = (contentType: string): MediaTypeDescriptor | undefined =>
  CONTENT_TYPE_TABLE[contentType.trim().toLowerCase()];

export interface MediaLimits {
  readonly maxImageBytes: number;
  readonly maxVideoBytes: number;
  readonly multipartThresholdBytes: number;
}

export const maxBytesForCategory = (limits: MediaLimits, category: MediaCategory): number =>
  category === 'image' ? limits.maxImageBytes : limits.maxVideoBytes;

/** Files at or above the threshold use multipart; everything else uses one presigned PUT. */
export const usesMultipartUpload = (limits: MediaLimits, sizeBytes: number): boolean =>
  sizeBytes >= limits.multipartThresholdBytes;

/** S3/R2 multipart requires every part but the last to be at least 5 MiB. */
const S3_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;

export const multipartPlan = (sizeBytes: number, configuredPartBytes: number): { partSizeBytes: number; partCount: number } => {
  const partSizeBytes = Math.max(configuredPartBytes, S3_MULTIPART_MIN_PART_BYTES);
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  return { partSizeBytes, partCount };
};

/** The folders of a client are few and the screen needs them all at once: the page is the ceiling. */
export const MEDIA_FOLDER_DEFAULT_PAGE_SIZE = 100;
export const MEDIA_FOLDER_ASSET_DEFAULT_PAGE_SIZE = 48;
