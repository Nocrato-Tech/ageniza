import { describe, expect, it } from 'vitest';

import { acceptedCategory, changesOf, fitMedia, mediaFromFolder, resetsApproval, type ContentFormValues } from './content-form.js';

const img = (n: number) => ({ id: `i${n}`, category: 'image' as const });
const vid = (n: number) => ({ id: `v${n}`, category: 'video' as const });
const base: ContentFormValues = { title: 'T', format: 'carousel', publishOn: '2026-10-20', publishAtTime: '', folderId: 'f1', caption: '', mediaAssetIds: ['i1'], coverAssetId: null };

describe('what a folder gives a content', () => {
  it('knows which kind each format takes', () => {
    expect(acceptedCategory('image')).toBe('image');
    expect(acceptedCategory('carousel')).toBeNull();
    for (const format of ['reels', 'long_video', 'vsl'] as const) expect(acceptedCategory(format)).toBe('video');
  });

  it('gives a carousel everything that fits, in the folder order, up to the limit', () => {
    const many = Array.from({ length: 25 }, (_, n) => img(n));
    expect(mediaFromFolder('carousel', [img(1), vid(1), img(2)])).toEqual(['i1', 'v1', 'i2']);
    expect(mediaFromFolder('carousel', many)).toHaveLength(20);
  });

  it('gives the other formats the first media of their kind, or nothing', () => {
    expect(mediaFromFolder('image', [vid(1), img(2), img(3)])).toEqual(['i2']);
    expect(mediaFromFolder('reels', [img(1), vid(2), vid(3)])).toEqual(['v2']);
    expect(mediaFromFolder('reels', [img(1)])).toEqual([]);
    expect(mediaFromFolder('image', [])).toEqual([]);
  });

  it('keeps what still fits after a format change, else takes the folder', () => {
    const folder = [img(1), vid(1), img(2)];
    expect(fitMedia('image', ['v1', 'i2', 'i1'], folder)).toEqual(['i2']);
    expect(fitMedia('reels', ['i1', 'i2'], folder)).toEqual(['v1']);
    expect(fitMedia('carousel', ['i2', 'gone'], folder)).toEqual(['i2']);
    expect(fitMedia('image', ['gone'], folder)).toEqual(['i1']);
  });
});

describe('what is sent on save', () => {
  it('carries the list whenever the folder changes, even an empty one', () => {
    expect(changesOf(base, { ...base, folderId: 'f2', mediaAssetIds: [] })).toEqual({ folderId: 'f2', mediaAssetIds: [] });
  });

  it('does not carry the list when only the title changed', () => {
    expect(changesOf(base, { ...base, title: 'Outro' })).toEqual({ title: 'Outro' });
  });

  it('annuls the approval when the folder move changes the media, and not when nothing was and nothing is', () => {
    expect(resetsApproval(base, { folderId: 'f2', mediaAssetIds: ['v1'] })).toBe(true);
    expect(resetsApproval(base, { folderId: 'f2', mediaAssetIds: [] })).toBe(true);
    expect(resetsApproval({ ...base, mediaAssetIds: [] }, { folderId: 'f2', mediaAssetIds: [] })).toBe(false);
    expect(resetsApproval(base, { title: 'x' })).toBe(false);
  });
});
