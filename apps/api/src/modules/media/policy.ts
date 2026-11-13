import type { MediaCategory, MediaLibraryCategory } from '@ageniza/contracts';

import type { SniffKind } from './content-sniff.js';
import { SVG_MAX_BYTES } from './svg-guard.js';

/** A fixed-window rate-limit policy, same shape as `../auth/policy.ts`. Upload URL emission is
 * rate-limited per issue #21 ("Rate limit na emissão de URLs de upload"). */
export interface MediaRateLimitWindow {
  readonly max: number;
  readonly windowMs: number;
}

/** Uploading is `midia.enviar` for the agency's own media and `conteudo.operar` for a client's; the route says which. */
export const MEDIA_UPLOAD_PERMISSIONS = ['midia.enviar', 'conteudo.operar'] as const;

/** The read URL is `midia.enviar` for the agency's own media and `conteudo.visualizar` for a client's (issue #550). The guard lets
 * either family in; the RLS of `media_assets` decides which rows the role sees, so the other family's media is a 404. */
export const MEDIA_READ_PERMISSIONS = ['midia.enviar', 'conteudo.visualizar'] as const;

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

/** The one bucket of the read URL: the agency's route and the portal's count the same person in the same store. */
export const MEDIA_READ_URL_BUCKET = 'media-read-url';

export const MEDIA_RATE_LIMITS = {
  // Applies to the routes that emit an upload URL: create-upload and request-parts, counted by IP.
  signedUrlIssuance: { max: 60, windowMs: FIFTEEN_MINUTES_MS },
  // Counted per user, across agencies. The window is the life of a signed URL; 600 is ~1.5x the worst realistic window of the screens (2026-10-11 decision, #558).
  downloadUrlPerUser: { max: 600, windowMs: FIVE_MINUTES_MS }
} as const satisfies Readonly<Record<string, MediaRateLimitWindow>>;

export interface MediaTypeDescriptor {
  /** The type without parameters, lowercase: what is stored as the confirmed type of the media. */
  readonly contentType: string;
  /** What the type is with no say of the agency: `logo` only for the SVG, which has no other home. */
  readonly category: MediaLibraryCategory;
  readonly extension: string;
  /** What the first bytes of the file must be; `undefined` for a video, which the worker reads with `ffprobe`. */
  readonly sniff: SniffKind | undefined;
  /** A raster image the agency may mark as a logo (`asLogo`). */
  readonly logoCapable: boolean;
}

const entry = (
  category: MediaLibraryCategory,
  extension: string,
  sniff: SniffKind | undefined,
  logoCapable = false
): Omit<MediaTypeDescriptor, 'contentType'> => ({ category, extension, sniff, logoCapable });

/**
 * Content types this deployment accepts, mapped to a category and a fixed extension. The
 * extension never comes from client-supplied file names: object keys must never carry anything
 * resembling personal data (issue #21), and only a small fixed set of extensions is meaningful to
 * the worker that will later process these files (issue tracked separately). The five types of the
 * library and what is accepted for each are the decision 2026-11-11 "a mídia aceita PDF, áudio e SVG
 * como logo": a PDF and an audio are support files, a logo is an image the agency marks, and an SVG is only that.
 */
const CONTENT_TYPE_TABLE: Readonly<Record<string, Omit<MediaTypeDescriptor, 'contentType'>>> = {
  'image/png': entry('image', 'png', 'png', true),
  'image/jpeg': entry('image', 'jpg', 'jpeg', true),
  'image/webp': entry('image', 'webp', 'webp', true),
  'image/gif': entry('image', 'gif', 'gif'),
  'image/svg+xml': entry('logo', 'svg', 'svg'),
  'video/mp4': entry('video', 'mp4', undefined),
  'video/quicktime': entry('video', 'mov', undefined),
  'video/webm': entry('video', 'webm', undefined),
  'application/pdf': entry('pdf', 'pdf', 'pdf'),
  'audio/mpeg': entry('audio', 'mp3', 'mp3'),
  'audio/mp4': entry('audio', 'm4a', 'm4a'),
  'audio/x-m4a': entry('audio', 'm4a', 'm4a'),
  'audio/wav': entry('audio', 'wav', 'wav'),
  'audio/x-wav': entry('audio', 'wav', 'wav'),
  'audio/wave': entry('audio', 'wav', 'wav'),
  'audio/webm': entry('audio', 'webm', 'webm'),
  'audio/ogg': entry('audio', 'ogg', 'ogg')
};

/** Returns `undefined` for any content type this deployment does not accept. The parameters (`;codecs=opus` of a recording) are not part of the type. */
export const describeMediaContentType = (contentType: string): MediaTypeDescriptor | undefined => {
  const base = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  const entry = Object.hasOwn(CONTENT_TYPE_TABLE, base) ? CONTENT_TYPE_TABLE[base] : undefined;
  return entry === undefined ? undefined : { contentType: base, ...entry };
};

/**
 * The category a file is stored in, or `undefined` when the pair is not accepted. A raster image is a logo only when the agency says
 * so, an SVG is accepted only as one, and a file that is not an image is never one.
 */
export const categoryForUpload = (descriptor: MediaTypeDescriptor, asLogo: boolean): MediaLibraryCategory | undefined => {
  if (asLogo) return descriptor.logoCapable || descriptor.category === 'logo' ? 'logo' : undefined;
  return descriptor.category === 'logo' ? undefined : descriptor.category;
};

/** Whether the type the object turned out to have is one the media was created for. */
export const descriptorFitsCategory = (descriptor: MediaTypeDescriptor, category: MediaLibraryCategory): boolean =>
  categoryForUpload(descriptor, category === 'logo') === category;

/**
 * What the signed GET of a file that is never shown as a page must carry: the type the server confirmed and `attachment`, so a PDF, an
 * audio or an SVG is saved (or loaded by an `<img>`, which ignores the disposition and runs no script) and never opened as a document
 * of the origin that serves it. `undefined` for the files the screens render, which keep the headers they were stored with.
 */
export const downloadResponseHeaders = (asset: {
  readonly category: MediaLibraryCategory;
  readonly confirmedContentType: string | null;
  readonly fileName: string | null;
  readonly extension: string;
}): { readonly responseContentType: string; readonly responseContentDisposition: string } | undefined => {
  if (asset.confirmedContentType === null) return undefined;
  const isSvg = asset.confirmedContentType === 'image/svg+xml';
  if (asset.category !== 'pdf' && asset.category !== 'audio' && !isSvg) return undefined;
  return {
    responseContentType: asset.confirmedContentType,
    responseContentDisposition: attachmentDisposition(asset.fileName, asset.extension)
  };
};

/** `attachment` with the name the person gave the file (and the extension of its type when the name lacks it), written for an old and a new reader. */
export const attachmentDisposition = (fileName: string | null, extension: string): string => {
  const base = fileName ?? 'download';
  const named = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
  const fallback = named.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(named).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** A photo and a video are the only categories of a content (`set_content_media`); the rest stay in the library. */
export const MEDIA_PICKABLE_CATEGORIES = ['image', 'video'] as const satisfies readonly MediaCategory[];

export interface MediaLimits {
  readonly maxImageBytes: number;
  readonly maxVideoBytes: number;
  readonly multipartThresholdBytes: number;
}

/** Ceilings of the support files, below the one of the video they are also held to: a recording or a brand book is not a film. */
export const MEDIA_AUDIO_MAX_BYTES = 200 * 1024 * 1024;
export const MEDIA_PDF_MAX_BYTES = 100 * 1024 * 1024;

export const maxBytesForCategory = (limits: MediaLimits, category: MediaLibraryCategory, contentType?: string): number => {
  switch (category) {
    case 'image': return limits.maxImageBytes;
    case 'video': return limits.maxVideoBytes;
    case 'pdf': return Math.min(MEDIA_PDF_MAX_BYTES, limits.maxVideoBytes);
    case 'audio': return Math.min(MEDIA_AUDIO_MAX_BYTES, limits.maxVideoBytes);
    case 'logo': return contentType === 'image/svg+xml' ? Math.min(SVG_MAX_BYTES, limits.maxImageBytes) : limits.maxImageBytes;
  }
};

/**
 * The keys of an upload, from the identifiers and the extension of its type alone: object keys never carry anything resembling personal
 * data (issue #21). The database builds the same two for the portal's upload (migration 20261113000100), and the integration test of the
 * portal's upload compares them with what it wrote.
 */
export const objectKeyFor = (agencyId: string, assetId: string, extension: string): string => `${agencyId}/${assetId}/original.${extension}`;
// All temporary objects share a leading prefix so R2 lifecycle can expire them without matching
// canonical originals or generated variants. R2 lifecycle filters support prefixes, not suffixes.
export const uploadObjectKeyFor = (agencyId: string, assetId: string, extension: string): string =>
  `staging/${agencyId}/${assetId}/upload.${extension}`;

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
/** A folder is "in use now" while its files were written within this many days (decision 2026-11-11, rule 10). */
export const MEDIA_FOLDER_IN_USE_WINDOW_DAYS = 30;
export const MEDIA_FOLDER_ASSET_DEFAULT_PAGE_SIZE = 48;
export const MEDIA_LIBRARY_DEFAULT_PAGE_SIZE = 48;
/** The contents that use one file are few: the screen lists them all at once. */
export const MEDIA_USAGE_DEFAULT_PAGE_SIZE = 100;
