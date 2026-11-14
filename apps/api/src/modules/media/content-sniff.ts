/**
 * What the bytes of an upload say it is, whatever its declared content type (decision 2026-11-11, "o tipo servido é o confirmado pelo
 * servidor, não o declarado"). The confirmation reads the first bytes of the object and keeps the file only when they open with the
 * signature of the type it declared; for an image it also takes the dimensions from the header.
 */

export type SniffKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'pdf' | 'mp3' | 'm4a' | 'wav' | 'webm' | 'ogg';

/** The ceiling of the dimensions the database holds (`media_assets_dimensions_shape`). */
export const MEDIA_DIMENSION_MAX = 100_000;

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** How many bytes of the start of the object each kind needs; a JPEG hides its size behind the segments of its metadata. */
export const SNIFF_WINDOW_BYTES: Readonly<Record<SniffKind, number>> = {
  png: 32,
  jpeg: 1024 * 1024,
  webp: 64,
  gif: 16,
  svg: 0,
  pdf: 8,
  mp3: 16,
  m4a: 16,
  wav: 16,
  webm: 8,
  ogg: 8
};

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const u16be = (bytes: Uint8Array, offset: number): number => (bytes[offset]! << 8) | bytes[offset + 1]!;
const u16le = (bytes: Uint8Array, offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8);
const u24le = (bytes: Uint8Array, offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
const u32be = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! * 0x1000000) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const pngDimensions = (bytes: Uint8Array): MediaDimensions | undefined => {
  // The first chunk of a PNG is always IHDR, 13 bytes long.
  if (bytes.length < 24 || u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
};

// The markers that carry a frame header (SOF), which are every one of 0xC0-0xCF but the three that are not frames.
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** The EXIF Orientation (1-8) of an APP1 segment whose payload spans `[start, end)`, or 1 when it is absent, truncated or malformed. */
const exifOrientation = (bytes: Uint8Array, start: number, end: number): number => {
  const limit = Math.min(end, bytes.length);
  if (limit - start < 14 || !ascii(bytes, start, 'Exif') || bytes[start + 4] !== 0 || bytes[start + 5] !== 0) return 1;
  const tiff = start + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  const u16 = (offset: number): number => (little ? u16le(bytes, offset) : u16be(bytes, offset));
  const u32 = (offset: number): number =>
    little ? (u16le(bytes, offset) + u16le(bytes, offset + 2) * 0x10000) : u32be(bytes, offset);
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > limit) return 1;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > limit) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
};

const jpegDimensions = (bytes: Uint8Array): MediaDimensions | undefined => {
  let position = 2;
  let orientation = 1;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return undefined;
    const marker = bytes[position + 1]!;
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    // Markers with no length: the restart markers, TEM, SOI and EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      position += 2;
      continue;
    }
    if (marker === 0xda) return undefined;
    const length = u16be(bytes, position + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (position + 9 > bytes.length || length < 7) return undefined;
      const height = u16be(bytes, position + 5);
      const width = u16be(bytes, position + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xe1) orientation = exifOrientation(bytes, position + 4, position + 2 + length);
    position += 2 + length;
  }
  return undefined;
};

const webpDimensions = (bytes: Uint8Array): MediaDimensions | undefined => {
  if (ascii(bytes, 12, 'VP8X') && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  if (ascii(bytes, 12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! * 0x1000000)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(bytes, 12, 'VP8 ') && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return undefined;
};

export type SniffResult =
  | { readonly matches: true; readonly dimensions: MediaDimensions | undefined }
  | { readonly matches: false };

const MATCH = { matches: true, dimensions: undefined } as const;
const NO_MATCH = { matches: false } as const;

/**
 * Whether the start of the object is a file of `kind`, with the dimensions its header gives when it is an image (`undefined` when the
 * header is that of the type but does not hold them in the window). An SVG is not read here: `svg-guard.ts` reads the whole of it.
 */
export const inspectMediaBytes = (kind: Exclude<SniffKind, 'svg'>, bytes: Uint8Array): SniffResult => {
  switch (kind) {
    case 'png':
      return startsWith(bytes, PNG_SIGNATURE) ? { matches: true, dimensions: pngDimensions(bytes) } : NO_MATCH;
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? { matches: true, dimensions: jpegDimensions(bytes) } : NO_MATCH;
    case 'webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP') ? { matches: true, dimensions: webpDimensions(bytes) } : NO_MATCH;
    case 'gif':
      return (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))
        ? { matches: true, dimensions: bytes.length >= 10 ? { width: u16le(bytes, 6), height: u16le(bytes, 8) } : undefined }
        : NO_MATCH;
    case 'pdf':
      return ascii(bytes, 0, '%PDF-') ? MATCH : NO_MATCH;
    case 'mp3':
      // An ID3 tag, or the sync of an MPEG audio frame (11 bits set).
      return ascii(bytes, 0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) ? MATCH : NO_MATCH;
    case 'm4a':
      return ascii(bytes, 4, 'ftyp') ? MATCH : NO_MATCH;
    case 'wav':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE') ? MATCH : NO_MATCH;
    case 'webm':
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) ? MATCH : NO_MATCH;
    case 'ogg':
      return ascii(bytes, 0, 'OggS') ? MATCH : NO_MATCH;
  }
};

/** The dimensions are kept only when they are a size the column holds; anything else is a file the library does not take. */
export const dimensionsAreValid = (dimensions: MediaDimensions): boolean =>
  Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height)
  && dimensions.width >= 1 && dimensions.height >= 1
  && dimensions.width <= MEDIA_DIMENSION_MAX && dimensions.height <= MEDIA_DIMENSION_MAX;
