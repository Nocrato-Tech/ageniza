/** The smallest files that open as each type the library takes: enough for the signature and the size in the header, not for a viewer. */

const bytes = (...parts: readonly (readonly number[] | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? Array.from(part, (character) => character.charCodeAt(0)) : part)));

const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

export const pngBytes = (width = 1, height = 1): Uint8Array =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0], be32(0), be32(0), 'IEND', be32(0));

/** SOI, an APP0 segment (so the frame is not the first one), then SOF0 with the size and EOI. */
export const jpegBytes = (width = 1, height = 1, options: { readonly progressive?: boolean } = {}): Uint8Array => bytes(
  [0xff, 0xd8],
  [0xff, 0xe0, 0x00, 0x10], 'JFIF\u0000', [1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, options.progressive === true ? 0xc2 : 0xc0, 0x00, 0x0b, 8, (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0],
  [0xff, 0xd9]
);

export const gifBytes = (width = 1, height = 1): Uint8Array => bytes('GIF89a', le16(width), le16(height), [0, 0, 0, 0x3b]);

export const webpBytes = (kind: 'lossy' | 'lossless' | 'extended', width = 1, height = 1): Uint8Array => {
  if (kind === 'extended') return bytes('RIFF', le32(22), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1));
  if (kind === 'lossless') {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    return bytes('RIFF', le32(18), 'WEBP', 'VP8L', le32(5), [0x2f], le32(bits >>> 0));
  }
  return bytes('RIFF', le32(26), 'WEBP', 'VP8 ', le32(10), [0, 0, 0, 0x9d, 0x01, 0x2a], le16(width), le16(height));
};

export const pdfBytes = (): Uint8Array => bytes('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
export const mp3Bytes = (): Uint8Array => bytes('ID3', [4, 0, 0, 0, 0, 0, 0], [0xff, 0xfb, 0x90, 0x00]);
export const m4aBytes = (): Uint8Array => bytes(be32(24), 'ftyp', 'M4A ', be32(0), 'M4A ', 'mp42');
export const wavBytes = (): Uint8Array => bytes('RIFF', le32(36), 'WAVE', 'fmt ', le32(16), [1, 0, 1, 0], le32(8000), le32(8000), [1, 0, 8, 0], 'data', le32(0));
export const webmBytes = (): Uint8Array => bytes([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x84], 'webm');
export const oggBytes = (): Uint8Array => bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);

export const SAFE_SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>';

export const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
