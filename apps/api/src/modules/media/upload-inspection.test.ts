import { describe, expect, it, vi } from 'vitest';

import type { MediaLibraryCategory } from '@ageniza/contracts';

import { MEDIA_AUDIO_MAX_BYTES, MEDIA_PDF_MAX_BYTES, type MediaLimits } from './policy.js';
import { SVG_MAX_BYTES } from './svg-guard.js';
import {
  gifBytes,
  jpegBytes,
  m4aBytes,
  mp3Bytes,
  oggBytes,
  pdfBytes,
  pngBytes,
  SAFE_SVG,
  textBytes,
  wavBytes,
  webmBytes,
  webpBytes
} from './test-support/files.js';
import { judgeUploadedObject } from './upload-inspection.js';

// The confirmation of an upload (decision 2026-11-11): the type the object has must be the declared one, the size inside the ceiling,
// and the first bytes must open as that type. An SVG is read whole and must pass the guard.

const limits: MediaLimits = { maxImageBytes: 25 * 1024 * 1024, maxVideoBytes: 5 * 1024 * 1024 * 1024, multipartThresholdBytes: 8 * 1024 * 1024 };

const storageWith = (bytes: Uint8Array) => ({
  readObjectStart: vi.fn(async ({ length }: { readonly key: string; readonly length: number }) => bytes.slice(0, length))
});

interface Case {
  readonly declared: string;
  readonly category: MediaLibraryCategory;
  readonly head?: { readonly contentType?: string | undefined; readonly sizeBytes?: number };
  readonly bytes: Uint8Array;
}

const judge = async ({ declared, category, head, bytes }: Case) => {
  const storage = storageWith(bytes);
  const verdict = await judgeUploadedObject(storage, limits, {
    key: 'agency/asset/original.bin',
    declaredContentType: declared,
    category,
    head: { sizeBytes: head?.sizeBytes ?? bytes.length, contentType: head !== undefined && 'contentType' in head ? head.contentType : declared }
  });
  return { verdict, storage };
};

describe('a file that is what it declared', () => {
  it.each([
    ['a PNG', 'image/png', 'image', pngBytes(3024, 4032), { width: 3024, height: 4032 }],
    ['a JPEG', 'image/jpeg', 'image', jpegBytes(4000, 3000), { width: 4000, height: 3000 }],
    ['a WebP', 'image/webp', 'image', webpBytes('lossy', 800, 600), { width: 800, height: 600 }],
    ['a GIF', 'image/gif', 'image', gifBytes(32, 16), { width: 32, height: 16 }],
    ['a PNG marked as a logo', 'image/png', 'logo', pngBytes(512, 512), { width: 512, height: 512 }],
    ['an SVG marked as a logo', 'image/svg+xml', 'logo', textBytes(SAFE_SVG), undefined],
    ['a PDF', 'application/pdf', 'pdf', pdfBytes(), undefined],
    ['an MP3', 'audio/mpeg', 'audio', mp3Bytes(), undefined],
    ['an M4A', 'audio/mp4', 'audio', m4aBytes(), undefined],
    ['a WAV', 'audio/wav', 'audio', wavBytes(), undefined],
    ['a WebM recording', 'audio/webm;codecs=opus', 'audio', webmBytes(), undefined],
    ['an Ogg', 'audio/ogg', 'audio', oggBytes(), undefined]
  ] as const)('confirms %s, with its dimensions when it is an image', async (_label, declared, category, bytes, dimensions) => {
    const { verdict } = await judge({ declared, category, bytes });
    expect(verdict).toEqual({ ok: true, contentType: declared.split(';')[0], dimensions });
  });

  it('confirms a video without reading it: the worker reads it with ffprobe', async () => {
    const { verdict, storage } = await judge({ declared: 'video/mp4', category: 'video', bytes: textBytes('not looked at') });
    expect(verdict).toEqual({ ok: true, contentType: 'video/mp4', dimensions: undefined });
    expect(storage.readObjectStart).not.toHaveBeenCalled();
  });

  it('keeps the type the object carries without its parameters', async () => {
    const { verdict } = await judge({ declared: 'audio/webm;codecs=opus', category: 'audio', head: { contentType: 'audio/webm; codecs=opus' }, bytes: webmBytes() });
    expect(verdict).toMatchObject({ ok: true, contentType: 'audio/webm' });
  });
});

describe('a file that is not what it declared', () => {
  it.each([
    ['text with the signature of nothing', 'image/png', 'image', textBytes('<html><script>alert(1)</script></html>')],
    ['a JPEG declared as a PNG', 'image/png', 'image', jpegBytes()],
    ['a PNG declared as a JPEG', 'image/jpeg', 'image', pngBytes()],
    ['a GIF declared as a WebP', 'image/webp', 'image', gifBytes()],
    ['a WAV declared as a WebP', 'image/webp', 'image', wavBytes()],
    ['a WebP declared as a WAV', 'audio/wav', 'audio', webpBytes('lossy')],
    ['an executable declared as a PDF', 'application/pdf', 'pdf', textBytes('MZ\u0090\u0000\u0003')],
    ['a PDF declared as an MP3', 'audio/mpeg', 'audio', pdfBytes()],
    ['an HTML page declared as an SVG logo', 'image/svg+xml', 'logo', textBytes('<html><body>x</body></html>')],
    ['a PNG declared as an Ogg', 'audio/ogg', 'audio', pngBytes()],
    ['a file of zeros declared as an image', 'image/png', 'image', new Uint8Array(100)]
  ] as const)('refuses %s', async (_label, declared, category, bytes) => {
    const { verdict } = await judge({ declared, category, bytes });
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok ? undefined : verdict.reason).toBe(declared === 'image/svg+xml' ? 'svg_rejected' : 'content_type_mismatch');
  });

  it('refuses an object whose stored type is not the declared one, even when its bytes fit the stored one', async () => {
    const { verdict, storage } = await judge({ declared: 'image/png', category: 'image', head: { contentType: 'image/jpeg' }, bytes: jpegBytes() });
    expect(verdict).toEqual({ ok: false, reason: 'content_type_mismatch' });
    expect(storage.readObjectStart).not.toHaveBeenCalled();
  });

  it.each([
    ['no stored type', undefined],
    ['a stored type that is not accepted', 'text/html'],
    ['a stored type of another category', 'video/mp4']
  ])('refuses an object with %s', async (_label, contentType) => {
    const { verdict } = await judge({ declared: 'image/png', category: 'image', head: { contentType }, bytes: pngBytes() });
    expect(verdict).toEqual({ ok: false, reason: 'content_type_mismatch' });
  });

  it('refuses an SVG that was not marked as a logo, and a GIF that was', async () => {
    expect((await judge({ declared: 'image/svg+xml', category: 'image', bytes: textBytes(SAFE_SVG) })).verdict).toEqual({ ok: false, reason: 'content_type_mismatch' });
    expect((await judge({ declared: 'image/gif', category: 'logo', bytes: gifBytes() })).verdict).toEqual({ ok: false, reason: 'content_type_mismatch' });
  });

  it('refuses an image whose header gives a size the column does not hold', async () => {
    for (const bytes of [pngBytes(0, 10), pngBytes(100_001, 10), pngBytes(10, 100_001)]) {
      expect((await judge({ declared: 'image/png', category: 'image', bytes })).verdict).toEqual({ ok: false, reason: 'invalid_dimensions' });
    }
  });

  it('keeps a file whose header is of the type but holds no size in the bytes read', async () => {
    const { verdict } = await judge({ declared: 'image/png', category: 'image', head: { sizeBytes: 5000 }, bytes: pngBytes().slice(0, 12) });
    expect(verdict).toEqual({ ok: true, contentType: 'image/png', dimensions: undefined });
  });
});

describe('an SVG that is a logo with something in it', () => {
  it.each([
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['an onload', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'],
    ['an external reference', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>']
  ])('is refused with %s, with the reason the confirmation records', async (_label, svg) => {
    const { verdict } = await judge({ declared: 'image/svg+xml', category: 'logo', bytes: textBytes(svg) });
    expect(verdict).toEqual({ ok: false, reason: 'svg_rejected' });
  });

  it('is read whole', async () => {
    const bytes = textBytes(SAFE_SVG);
    const { storage } = await judge({ declared: 'image/svg+xml', category: 'logo', bytes });
    expect(storage.readObjectStart).toHaveBeenCalledWith({ key: 'agency/asset/original.bin', length: bytes.length });
  });
});

describe('the size of a file', () => {
  it('refuses what is above the ceiling of its category, before reading a byte', async () => {
    const cases: readonly (readonly [string, MediaLibraryCategory, string, number])[] = [
      ['image/png', 'image', 'png', limits.maxImageBytes + 1],
      ['image/png', 'logo', 'logo png', limits.maxImageBytes + 1],
      ['image/svg+xml', 'logo', 'svg', SVG_MAX_BYTES + 1],
      ['application/pdf', 'pdf', 'pdf', MEDIA_PDF_MAX_BYTES + 1],
      ['audio/mpeg', 'audio', 'audio', MEDIA_AUDIO_MAX_BYTES + 1]
    ];
    for (const [declared, category, label, sizeBytes] of cases) {
      const { verdict, storage } = await judge({ declared, category, head: { sizeBytes }, bytes: new Uint8Array(8) });
      expect(verdict, label).toEqual({ ok: false, reason: 'too_large' });
      expect(storage.readObjectStart, label).not.toHaveBeenCalled();
    }
  });

  it('accepts one of exactly the ceiling', async () => {
    const { verdict } = await judge({ declared: 'application/pdf', category: 'pdf', head: { sizeBytes: MEDIA_PDF_MAX_BYTES }, bytes: pdfBytes() });
    expect(verdict).toMatchObject({ ok: true });
  });

  it('refuses an empty object, which the column of the size does not hold', async () => {
    const { verdict } = await judge({ declared: 'image/png', category: 'image', head: { sizeBytes: 0 }, bytes: new Uint8Array(0) });
    expect(verdict).toEqual({ ok: false, reason: 'empty_object' });
  });

  it('reads only the start of an image: what a header needs, and no more than the object has', async () => {
    const png = await judge({ declared: 'image/png', category: 'image', head: { sizeBytes: 10_000_000 }, bytes: pngBytes() });
    expect(png.storage.readObjectStart).toHaveBeenCalledWith({ key: 'agency/asset/original.bin', length: 32 });
    const jpeg = await judge({ declared: 'image/jpeg', category: 'image', head: { sizeBytes: 20_000_000 }, bytes: jpegBytes() });
    expect(jpeg.storage.readObjectStart).toHaveBeenCalledWith({ key: 'agency/asset/original.bin', length: 1024 * 1024 });
    const tiny = await judge({ declared: 'application/pdf', category: 'pdf', bytes: pdfBytes() });
    expect(tiny.storage.readObjectStart.mock.calls[0]?.[0].length).toBe(8);
  });
});
