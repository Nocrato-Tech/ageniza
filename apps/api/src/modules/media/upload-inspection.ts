import type { MediaLibraryCategory } from '@ageniza/contracts';

import { dimensionsAreValid, inspectMediaBytes, SNIFF_WINDOW_BYTES, type MediaDimensions } from './content-sniff.js';
import { describeMediaContentType, descriptorFitsCategory, maxBytesForCategory, type MediaLimits } from './policy.js';
import type { MediaStorageClient } from './storage-client.js';
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
