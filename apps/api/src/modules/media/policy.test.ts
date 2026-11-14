import { describe, expect, it } from 'vitest';

import {
  attachmentDisposition,
  categoryForUpload,
  describeMediaContentType,
  descriptorFitsCategory,
  downloadResponseHeaders,
  maxBytesForCategory,
  MEDIA_AUDIO_MAX_BYTES,
  MEDIA_PDF_MAX_BYTES,
  type MediaLimits
} from './policy.js';
import { SVG_MAX_BYTES } from './svg-guard.js';

// Decision 2026-11-11 "a mídia aceita PDF, áudio e SVG como logo": the list of types is defined in code, a logo is an image the
// agency marks, and what is never opened as a page is served as a download of the type the server confirmed.

const limits: MediaLimits = { maxImageBytes: 25 * 1024 * 1024, maxVideoBytes: 5 * 1024 * 1024 * 1024, multipartThresholdBytes: 8 * 1024 * 1024 };

const describeOrFail = (contentType: string) => {
  const descriptor = describeMediaContentType(contentType);
  if (descriptor === undefined) throw new Error(`${contentType} is not described`);
  return descriptor;
};

describe('the content types the library accepts', () => {
  it.each([
    ['image/png', 'image', 'png'],
    ['image/jpeg', 'image', 'jpg'],
    ['image/webp', 'image', 'webp'],
    ['image/gif', 'image', 'gif'],
    ['image/svg+xml', 'logo', 'svg'],
    ['video/mp4', 'video', 'mp4'],
    ['video/quicktime', 'video', 'mov'],
    ['video/webm', 'video', 'webm'],
    ['application/pdf', 'pdf', 'pdf'],
    ['audio/mpeg', 'audio', 'mp3'],
    ['audio/mp4', 'audio', 'm4a'],
    ['audio/x-m4a', 'audio', 'm4a'],
    ['audio/wav', 'audio', 'wav'],
    ['audio/x-wav', 'audio', 'wav'],
    ['audio/wave', 'audio', 'wav'],
    ['audio/webm', 'audio', 'webm'],
    ['audio/ogg', 'audio', 'ogg']
  ])('%s is a %s with the fixed extension .%s', (contentType, category, extension) => {
    expect(describeMediaContentType(contentType)).toMatchObject({ contentType, category, extension });
  });

  it('reads the type without its case, its blanks or its parameters (a recording says audio/webm;codecs=opus)', () => {
    expect(describeMediaContentType('  Audio/WebM ; codecs=opus ')).toMatchObject({ contentType: 'audio/webm', extension: 'webm' });
    expect(describeMediaContentType('IMAGE/PNG')).toMatchObject({ contentType: 'image/png' });
  });

  it.each([
    'text/html',
    'text/plain',
    'application/octet-stream',
    'application/javascript',
    'application/x-msdownload',
    'image/svg',
    'image/heic',
    'image/x-icon',
    'image/bmp',
    'image/tiff',
    'video/x-matroska',
    'audio/flac',
    'application/zip',
    'application/msword',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    '',
    ';image/png'
  ])('refuses %j', (contentType) => {
    expect(describeMediaContentType(contentType)).toBeUndefined();
  });

  it('gives a PNG, a JPEG and a WebP the right to be a logo, and no other type', () => {
    const logoCapable = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf', 'audio/mpeg', 'image/svg+xml']
      .filter((type) => describeOrFail(type).logoCapable);
    expect(logoCapable).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });
});

describe('the category a file is stored in', () => {
  it.each([
    ['image/png', false, 'image'],
    ['image/png', true, 'logo'],
    ['image/jpeg', true, 'logo'],
    ['image/webp', true, 'logo'],
    ['image/gif', false, 'image'],
    ['image/gif', true, undefined],
    ['image/svg+xml', true, 'logo'],
    ['image/svg+xml', false, undefined],
    ['video/mp4', false, 'video'],
    ['video/mp4', true, undefined],
    ['application/pdf', false, 'pdf'],
    ['application/pdf', true, undefined],
    ['audio/mpeg', false, 'audio'],
    ['audio/mpeg', true, undefined]
  ])('%s with asLogo %s is %s', (contentType, asLogo, category) => {
    expect(categoryForUpload(describeOrFail(contentType), asLogo)).toBe(category);
  });

  it('is the one the object must turn out to fit when the upload is confirmed', () => {
    expect(descriptorFitsCategory(describeOrFail('image/png'), 'image')).toBe(true);
    expect(descriptorFitsCategory(describeOrFail('image/png'), 'logo')).toBe(true);
    expect(descriptorFitsCategory(describeOrFail('image/svg+xml'), 'logo')).toBe(true);
    expect(descriptorFitsCategory(describeOrFail('image/svg+xml'), 'image')).toBe(false);
    expect(descriptorFitsCategory(describeOrFail('image/gif'), 'logo')).toBe(false);
    expect(descriptorFitsCategory(describeOrFail('video/mp4'), 'image')).toBe(false);
    expect(descriptorFitsCategory(describeOrFail('audio/mpeg'), 'pdf')).toBe(false);
    expect(descriptorFitsCategory(describeOrFail('application/pdf'), 'pdf')).toBe(true);
  });
});

describe('the largest file of each category', () => {
  it('keeps the limits of a photo and a video, and gives the support files their own below the video', () => {
    expect(maxBytesForCategory(limits, 'image')).toBe(limits.maxImageBytes);
    expect(maxBytesForCategory(limits, 'video')).toBe(limits.maxVideoBytes);
    expect(maxBytesForCategory(limits, 'pdf')).toBe(MEDIA_PDF_MAX_BYTES);
    expect(maxBytesForCategory(limits, 'audio')).toBe(MEDIA_AUDIO_MAX_BYTES);
    expect(maxBytesForCategory(limits, 'logo', 'image/png')).toBe(limits.maxImageBytes);
    expect(maxBytesForCategory(limits, 'logo', 'image/svg+xml')).toBe(SVG_MAX_BYTES);
  });

  it('never gives a support file more than the video ceiling of the deployment, nor an SVG more than the image one', () => {
    const small: MediaLimits = { ...limits, maxImageBytes: 1024, maxVideoBytes: 2048 };
    expect(maxBytesForCategory(small, 'pdf')).toBe(2048);
    expect(maxBytesForCategory(small, 'audio')).toBe(2048);
    expect(maxBytesForCategory(small, 'logo', 'image/svg+xml')).toBe(1024);
  });
});

describe('what the signed GET of a file that is never a page carries', () => {
  const asset = (overrides: Partial<Parameters<typeof downloadResponseHeaders>[0]> = {}): Parameters<typeof downloadResponseHeaders>[0] => ({
    category: 'logo',
    confirmedContentType: 'image/svg+xml',
    fileName: 'logo da loja',
    extension: 'svg',
    ...overrides
  });

  it('forces the confirmed type and a download on an SVG, a PDF and an audio', () => {
    expect(downloadResponseHeaders(asset())).toEqual({
      responseContentType: 'image/svg+xml',
      responseContentDisposition: 'attachment; filename="logo da loja.svg"; filename*=UTF-8\'\'logo%20da%20loja.svg'
    });
    expect(downloadResponseHeaders(asset({ category: 'pdf', confirmedContentType: 'application/pdf', extension: 'pdf' }))?.responseContentType).toBe('application/pdf');
    expect(downloadResponseHeaders(asset({ category: 'audio', confirmedContentType: 'audio/mpeg', extension: 'mp3' }))?.responseContentType).toBe('audio/mpeg');
  });

  it('forces the download on an SVG whatever category the row says', () => {
    expect(downloadResponseHeaders(asset({ category: 'image' }))?.responseContentDisposition).toMatch(/^attachment;/);
  });

  it('leaves the files the screens render with their own headers', () => {
    expect(downloadResponseHeaders(asset({ category: 'image', confirmedContentType: 'image/png', extension: 'png' }))).toBeUndefined();
    expect(downloadResponseHeaders(asset({ category: 'logo', confirmedContentType: 'image/webp', extension: 'webp' }))).toBeUndefined();
    expect(downloadResponseHeaders(asset({ category: 'video', confirmedContentType: 'video/mp4', extension: 'mp4' }))).toBeUndefined();
  });

  it('says nothing when the type was never confirmed', () => {
    expect(downloadResponseHeaders(asset({ confirmedContentType: null }))).toBeUndefined();
  });
});

describe('the name a download is saved with', () => {
  it('uses the name of the file, with the extension of its type when the name lacks it', () => {
    expect(attachmentDisposition('Relatório', 'pdf')).toBe('attachment; filename="Relat_rio.pdf"; filename*=UTF-8\'\'Relat%C3%B3rio.pdf');
    expect(attachmentDisposition('manual.PDF', 'pdf')).toBe('attachment; filename="manual.PDF"; filename*=UTF-8\'\'manual.PDF');
  });

  it('names a file that has no name', () => {
    expect(attachmentDisposition(null, 'svg')).toBe('attachment; filename="download.svg"; filename*=UTF-8\'\'download.svg');
  });

  it('cannot be turned into another header or another parameter, whatever the name holds', () => {
    const disposition = attachmentDisposition('a"; filename="evil.html\r\nX-Injected: 1; \\ %00 \'(*)', 'svg');
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/filename="([^"]*)"/)?.[1]).toBe('a__ filename=_evil.html__X-Injected: 1_ _ _00 \'(*).svg'.replace(/[^\x20-\x7e]|["\\%;]/g, '_'));
    expect(disposition.split(';').length).toBe(3);
    expect(disposition.split('filename*=UTF-8\'\'')[1]).not.toMatch(/['()*";\\ ]/);
  });
});
