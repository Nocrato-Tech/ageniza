import type { MediaLibraryCategory } from '@ageniza/contracts';

import { dimensionsAreValid, inspectMediaBytes, SNIFF_WINDOW_BYTES, type MediaDimensions } from './content-sniff.js';
import { describeMediaContentType, descriptorFitsCategory, maxBytesForCategory, type MediaLimits } from './policy.js';
import type { HeadObjectResult, MediaStorageClient } from './storage-client.js';
import { inspectSvg } from './svg-guard.js';

export type UploadVerdict =
  | { readonly ok: true; readonly contentType: string; readonly dimensions: MediaDimensions | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides whether the object a confirmation found is the file the upload declared (decision 2026-11-11: the type served is the one
 * the server confirmed, not the declared one). The type the object carries must be the declared one and fit the category, the size
 * must be inside the ceiling of the category, and the bytes must open as that type: an SVG is read whole and must pass the guard, any
 * other file by its signature. Anything else is a rejection, whose reason the confirmation records.
 */
export const judgeUploadedObject = async (
  storage: Pick<MediaStorageClient, 'readObjectStart'>,
  limits: MediaLimits,
  input: {
    readonly key: string;
    readonly declaredContentType: string;
    readonly category: MediaLibraryCategory;
    readonly head: { readonly sizeBytes: number; readonly contentType: string | undefined };
  }
): Promise<UploadVerdict> => {
  const declared = describeMediaContentType(input.declaredContentType);
  const actual = input.head.contentType === undefined ? undefined : describeMediaContentType(input.head.contentType);
  if (actual === undefined || declared === undefined || actual.contentType !== declared.contentType || !descriptorFitsCategory(actual, input.category)) {
    return { ok: false, reason: 'content_type_mismatch' };
  }
  if (input.head.sizeBytes > maxBytesForCategory(limits, input.category, actual.contentType)) return { ok: false, reason: 'too_large' };
  if (input.head.sizeBytes === 0) return { ok: false, reason: 'empty_object' };
  if (actual.sniff === undefined) return { ok: true, contentType: actual.contentType, dimensions: undefined };

  if (actual.sniff === 'svg') {
    const bytes = await storage.readObjectStart({ key: input.key, length: input.head.sizeBytes });
    return inspectSvg(bytes).ok
      ? { ok: true, contentType: actual.contentType, dimensions: undefined }
      : { ok: false, reason: 'svg_rejected' };
  }

  const bytes = await storage.readObjectStart({ key: input.key, length: Math.min(SNIFF_WINDOW_BYTES[actual.sniff], input.head.sizeBytes) });
  const sniffed = inspectMediaBytes(actual.sniff, bytes);
  if (!sniffed.matches) return { ok: false, reason: 'content_type_mismatch' };
  if (sniffed.dimensions !== undefined && !dimensionsAreValid(sniffed.dimensions)) return { ok: false, reason: 'invalid_dimensions' };
  return { ok: true, contentType: actual.contentType, dimensions: sniffed.dimensions };
};

export type StagedInspection =
  | { readonly stagingFound: false; readonly copied: false }
  | { readonly stagingFound: true; readonly copied: false; readonly verdict: Extract<UploadVerdict, { readonly ok: false }> }
  | { readonly stagingFound: true; readonly copied: true; readonly head: HeadObjectResult | undefined; readonly verdict: UploadVerdict };

/**
 * What a confirmation does with the object a browser left in staging, for the agency's route and the portal's: copy it to the key that
 * will keep it, then judge the copy. A still-valid browser URL can mutate only staging, so the copy is made first and the immutable
 * canonical key is what is read: an overwrite between the head and the copy cannot smuggle other bytes past the verdict. `copied` says
 * whether the canonical key now holds an object the caller must delete if it does not keep it. `maxCopyBytes` refuses a staging object
 * that is already too big before it is copied.
 */
export const copyAndInspectStagedObject = async (
  storage: Pick<MediaStorageClient, 'headObject' | 'copyObject' | 'readObjectStart'>,
  limits: MediaLimits,
  input: {
    readonly stagingKey: string;
    readonly canonicalKey: string;
    readonly declaredContentType: string;
    readonly category: MediaLibraryCategory;
    readonly maxCopyBytes?: number;
    /** Called the moment the canonical key holds an object, before anything that can throw: the caller's cleanup of a failure needs it. */
    readonly onCopied?: () => void;
  }
): Promise<StagedInspection> => {
  const stagingHead = await storage.headObject({ key: input.stagingKey });
  if (stagingHead === undefined) return { stagingFound: false, copied: false };
  if (input.maxCopyBytes !== undefined && stagingHead.sizeBytes > input.maxCopyBytes) {
    return { stagingFound: true, copied: false, verdict: { ok: false, reason: 'too_large' } };
  }
  await storage.copyObject({ sourceKey: input.stagingKey, destinationKey: input.canonicalKey });
  input.onCopied?.();
  // The R2/S3 protocol offers no upload-time size policy for a presigned PUT: this head observes exactly the object that survives.
  const head = await storage.headObject({ key: input.canonicalKey });
  if (head === undefined) return { stagingFound: true, copied: true, head, verdict: { ok: false, reason: 'object_not_found' } };
  const verdict = await judgeUploadedObject(storage, limits, {
    key: input.canonicalKey,
    declaredContentType: input.declaredContentType,
    category: input.category,
    head
  });
  return { stagingFound: true, copied: true, head, verdict };
};
