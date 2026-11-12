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
