import { describe, expect, it } from 'vitest';

import { dimensionsAreValid, inspectMediaBytes, MEDIA_DIMENSION_MAX, SNIFF_WINDOW_BYTES } from './content-sniff.js';
import {
  gifBytes,
  jpegBytes,
  m4aBytes,
  mp3Bytes,
  oggBytes,
  pdfBytes,
  pngBytes,
  textBytes,
  wavBytes,
  webmBytes,
  webpBytes
} from './test-support/files.js';

// The confirmation of an upload keeps a file only when its first bytes are those of the type it declared (decision 2026-11-11).

describe('the dimensions an image gives', () => {
  it('reads a PNG from its IHDR', () => {
    expect(inspectMediaBytes('png', pngBytes(3024, 4032))).toEqual({ matches: true, dimensions: { width: 3024, height: 4032 } });
  });

  it('reads a JPEG from its frame header, past the segments that come first, baseline or progressive', () => {
    expect(inspectMediaBytes('jpeg', jpegBytes(4000, 3000))).toEqual({ matches: true, dimensions: { width: 4000, height: 3000 } });
    expect(inspectMediaBytes('jpeg', jpegBytes(640, 480, { progressive: true }))).toEqual({ matches: true, dimensions: { width: 640, height: 480 } });
  });

  it.each(['lossy', 'lossless', 'extended'] as const)('reads a %s WebP', (kind) => {
    expect(inspectMediaBytes('webp', webpBytes(kind, 1280, 720))).toEqual({ matches: true, dimensions: { width: 1280, height: 720 } });
  });

  it('reads a WebP of 16384 pixels (the widest the lossless format holds)', () => {
    expect(inspectMediaBytes('webp', webpBytes('lossless', 16384, 2))).toEqual({ matches: true, dimensions: { width: 16384, height: 2 } });
  });

  it('reads a GIF from its screen descriptor', () => {
    expect(inspectMediaBytes('gif', gifBytes(320, 200))).toEqual({ matches: true, dimensions: { width: 320, height: 200 } });
  });

  it('says the type matches but gives no size when the header is not in the bytes read', () => {
    expect(inspectMediaBytes('png', pngBytes().slice(0, 12))).toEqual({ matches: true, dimensions: undefined });
    expect(inspectMediaBytes('jpeg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0))).toEqual({ matches: true, dimensions: undefined });
    expect(inspectMediaBytes('jpeg', Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0, 0))).toEqual({ matches: true, dimensions: undefined });
  });

  it('takes the size of a PNG only from an IHDR of 13 bytes, which is always its first chunk', () => {
    const otherChunk = pngBytes(3, 4);
    otherChunk.set(textBytes('tEXt'), 12);
    expect(inspectMediaBytes('png', otherChunk)).toEqual({ matches: true, dimensions: undefined });
    const otherLength = pngBytes(3, 4);
    otherLength.set([0, 0, 0, 12], 8);
    expect(inspectMediaBytes('png', otherLength)).toEqual({ matches: true, dimensions: undefined });
  });

  it('takes the size of a JPEG from the frame, never from the tables that may come before it', () => {
    // A DHT (0xC4) segment first: read as a frame it would say 258 by 772.
    const withTable = Uint8Array.of(0xff, 0xd8, 0xff, 0xc4, 0x00, 0x0b, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, ...jpegBytes(640, 480).slice(2));
    expect(inspectMediaBytes('jpeg', withTable)).toEqual({ matches: true, dimensions: { width: 640, height: 480 } });
  });

  it('does not run past a segment that says it is shorter than its own length bytes', () => {
    expect(inspectMediaBytes('jpeg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xc0))).toEqual({ matches: true, dimensions: undefined });
  });
});

describe('the signature of each type', () => {
  const samples = {
    png: pngBytes(),
    jpeg: jpegBytes(),
    webp: webpBytes('lossy'),
    gif: gifBytes(),
    pdf: pdfBytes(),
    mp3: mp3Bytes(),
    m4a: m4aBytes(),
    wav: wavBytes(),
    webm: webmBytes(),
    ogg: oggBytes()
  } as const;

  it.each(Object.entries(samples))('accepts a %s as itself', (kind, bytes) => {
    expect(inspectMediaBytes(kind as keyof typeof samples, bytes).matches).toBe(true);
  });

  it.each(Object.keys(samples))('refuses what is not a %s: every other type, text, and nothing', (kind) => {
    for (const [other, bytes] of Object.entries(samples)) {
      if (other === kind) continue;
      // A WAV and a WebP share the RIFF opening and differ at the eighth byte: each must still refuse the other.
      expect(inspectMediaBytes(kind as keyof typeof samples, bytes).matches, `${kind} read ${other}`).toBe(false);
    }
    expect(inspectMediaBytes(kind as keyof typeof samples, textBytes('<html><script>alert(1)</script></html>')).matches).toBe(false);
    expect(inspectMediaBytes(kind as keyof typeof samples, new Uint8Array(0)).matches).toBe(false);
  });

  it('accepts an MP3 that opens with an MPEG frame and no tag, and refuses a lone 0xFF', () => {
    expect(inspectMediaBytes('mp3', Uint8Array.of(0xff, 0xfb, 0x90, 0x00)).matches).toBe(true);
    expect(inspectMediaBytes('mp3', Uint8Array.of(0xff, 0x1b)).matches).toBe(false);
    expect(inspectMediaBytes('mp3', Uint8Array.of(0xff)).matches).toBe(false);
  });

  it('refuses a PNG whose signature is damaged at the last byte', () => {
    const damaged = pngBytes();
    damaged[7] = 0x0b;
    expect(inspectMediaBytes('png', damaged).matches).toBe(false);
  });

  it('refuses a PDF whose header is not at the start', () => {
    expect(inspectMediaBytes('pdf', textBytes(' %PDF-1.7')).matches).toBe(false);
  });

  it('asks for a window that holds each header', () => {
    expect(SNIFF_WINDOW_BYTES.png).toBeGreaterThanOrEqual(24);
    expect(SNIFF_WINDOW_BYTES.webp).toBeGreaterThanOrEqual(30);
    expect(SNIFF_WINDOW_BYTES.gif).toBeGreaterThanOrEqual(10);
    expect(SNIFF_WINDOW_BYTES.jpeg).toBeGreaterThanOrEqual(64 * 1024);
  });
});

describe('the dimensions the column holds', () => {
  it.each([
    [{ width: 1, height: 1 }, true],
    [{ width: MEDIA_DIMENSION_MAX, height: MEDIA_DIMENSION_MAX }, true],
    [{ width: 0, height: 10 }, false],
    [{ width: 10, height: 0 }, false],
    [{ width: MEDIA_DIMENSION_MAX + 1, height: 10 }, false],
    [{ width: 10, height: MEDIA_DIMENSION_MAX + 1 }, false],
    [{ width: 1.5, height: 10 }, false],
    [{ width: Number.NaN, height: 10 }, false],
    [{ width: -1, height: 10 }, false]
  ])('%j is %s', (dimensions, valid) => {
    expect(dimensionsAreValid(dimensions)).toBe(valid);
  });
});

describe('the EXIF orientation of a JPEG', () => {
  const u16 = (value: number, little: boolean): number[] => (little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number, little: boolean): number[] =>
    little ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff] : [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

  const exifSegment = (orientation: number, little: boolean, { ifdOffset = 8, count = 1 }: { ifdOffset?: number; count?: number } = {}): number[] => {
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42, little),
      ...u32(ifdOffset, little),
      ...u16(count, little),
      ...u16(0x0112, little), ...u16(3, little), ...u32(1, little), ...u16(orientation, little), 0, 0,
      ...u32(0, little)
    ];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    return [0xff, 0xe1, ...u16(payload.length + 2, false), ...payload];
  };

  const withApp1 = (segment: number[], width = 4000, height = 3000): Uint8Array =>
    Uint8Array.of(0xff, 0xd8, ...segment, ...jpegBytes(width, height).slice(2));

  const dimensionsOf = (bytes: Uint8Array) => inspectMediaBytes('jpeg', bytes);

  it.each([true, false])('reads orientations 1 to 8 (little endian: %s)', (little) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const expected = orientation >= 5 ? { width: 3000, height: 4000 } : { width: 4000, height: 3000 };
      expect(dimensionsOf(withApp1(exifSegment(orientation, little)))).toEqual({ matches: true, dimensions: expected });
    }
  });

  it('keeps the dimensions when the orientation is out of range', () => {
    for (const orientation of [0, 9, 255]) {
      expect(dimensionsOf(withApp1(exifSegment(orientation, true)))).toEqual({ matches: true, dimensions: { width: 4000, height: 3000 } });
    }
  });

  it('keeps the dimensions when there is no EXIF or it is not EXIF', () => {
    expect(dimensionsOf(jpegBytes(4000, 3000))).toEqual({ matches: true, dimensions: { width: 4000, height: 3000 } });
    const xmp = [0xff, 0xe1, 0x00, 0x0a, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x78];
    expect(dimensionsOf(withApp1(xmp))).toEqual({ matches: true, dimensions: { width: 4000, height: 3000 } });
  });

  it('falls back to no orientation on a truncated, out-of-range or absurd EXIF without throwing', () => {
    const plain = { matches: true, dimensions: { width: 4000, height: 3000 } };
    const good = exifSegment(6, true);
    for (const cut of [8, 12, 16, 20, 24, 28]) {
      const truncated = Uint8Array.of(0xff, 0xd8, ...good.slice(0, cut));
      expect(() => dimensionsOf(truncated)).not.toThrow();
    }
    // The segment says it ends before the entry does.
    const shortSegment = [...good];
    shortSegment[2] = 0;
    shortSegment[3] = 20;
    expect(dimensionsOf(withApp1(shortSegment))).not.toEqual({ matches: true, dimensions: { width: 3000, height: 4000 } });
    // IFD offset past the buffer, near 2^32, and an absurd entry count.
    expect(dimensionsOf(withApp1(exifSegment(6, true, { ifdOffset: 0x7fffffff })))).toEqual(plain);
    expect(dimensionsOf(withApp1(exifSegment(6, false, { ifdOffset: 0xfffffff0 })))).toEqual(plain);
    expect(dimensionsOf(withApp1(exifSegment(6, true, { count: 0xffff })))).toEqual({ matches: true, dimensions: { width: 3000, height: 4000 } });
    const noMatchBeyond = exifSegment(6, true, { count: 0xffff });
    noMatchBeyond[noMatchBeyond.length - 1] = 0;
    expect(() => dimensionsOf(withApp1(noMatchBeyond))).not.toThrow();
  });

  const guarded = (bytes: Uint8Array): Uint8Array =>
    new Proxy(bytes, {
      get: (target, key) => {
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= target.length) throw new RangeError(`read at ${key} outside the buffer`);
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });

  it('never reads outside the buffer, whatever the EXIF says', () => {
    const good = exifSegment(6, true);
    for (let cut = 4; cut < good.length; cut += 1) {
      expect(() => dimensionsOf(guarded(Uint8Array.of(0xff, 0xd8, ...good.slice(0, cut))))).not.toThrow();
    }
    expect(() => dimensionsOf(guarded(withApp1(exifSegment(6, true, { count: 0xffff }))))).not.toThrow();
    expect(() => dimensionsOf(guarded(Uint8Array.of(0xff, 0xd8, ...exifSegment(6, true, { ifdOffset: 0xfffffff0 }))))).not.toThrow();
    const hugeSegment = [...good];
    hugeSegment[2] = 0xff;
    hugeSegment[3] = 0xff;
    expect(() => dimensionsOf(guarded(Uint8Array.of(0xff, 0xd8, ...hugeSegment)))).not.toThrow();
  });

  it('reads only inside the segment that declares the EXIF', () => {
    const plain = { matches: true, dimensions: { width: 4000, height: 3000 } };
    const tail = jpegBytes(4000, 3000).slice(2);
    const head = [0xff, 0xd8, 0xff, 0xe1];
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0x00];
    // The IFD (offset 12) starts inside a COM segment that follows the APP1, not inside the APP1.
    const ifdOutside = [...head, 0x00, 0x10, ...exif, 0x0c, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x10, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00];
    expect(dimensionsOf(Uint8Array.of(...ifdOutside, ...tail))).toEqual(plain);
    // The entry starts inside the APP1 and its value lies in the COM segment that follows.
    const entryHalfOutside = [...head, 0x00, 0x16, ...exif, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0xff, 0xfe, 0x00, 0x0a, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    expect(dimensionsOf(Uint8Array.of(...entryHalfOutside, ...tail))).toEqual(plain);
  });

  it('ignores an EXIF beyond the bytes the sniff reads', () => {
    const filler = [0xff, 0xe0, 0xff, 0xff, ...new Array<number>(0xffff - 2).fill(0)];
    const parts = [Uint8Array.of(0xff, 0xd8), ...Array.from({ length: 17 }, () => Uint8Array.from(filler)), Uint8Array.from(exifSegment(6, true)), jpegBytes(4000, 3000).slice(2)];
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    expect(bytes.length).toBeGreaterThan(SNIFF_WINDOW_BYTES.jpeg);
    expect(dimensionsOf(bytes.slice(0, SNIFF_WINDOW_BYTES.jpeg))).toEqual({ matches: true, dimensions: undefined });
  });
});
