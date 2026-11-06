import { expect, it } from 'vitest';
import { editorErrors } from './editor-state';
import type { Asset, PostInput } from './types';

const image: Asset = { id: 'image', clientId: 'client', folderId: 'folder', name: 'Capa.png', kind: 'image', size: 10 };
const video: Asset = { ...image, id: 'video', name: 'Reel.mp4', kind: 'video' };
const input: PostInput = { clientId: 'client', folderId: 'folder', title: 'Título', caption: '', format: 'reels', date: '2026-11-06', time: '', ownerId: '', mediaIds: [video.id, image.id], coverId: image.id };

it('explains that a reel with a video and a cover image attached has too many media, while its separate cover is valid', () => {
  const errors = editorErrors(input, 1, [image, video]);
  expect(errors.mediaIds).toMatch(/1 arquivo/);
  expect(errors.coverId).toBeUndefined();
  expect(editorErrors({ ...input, mediaIds: [video.id] }, 1, [image, video])).toEqual({});
});

it('rejects a video cover even with a sample thumbnail, and a cover from a different folder or client', () => {
  for (const cover of [{ ...video, sample: true }, { ...image, folderId: 'other' }, { ...image, clientId: 'other' }]) {
    expect(editorErrors({ ...input, mediaIds: [], coverId: cover.id }, 1, [cover]).coverId).toBeTruthy();
  }
  for (const format of ['image', 'carousel', 'reels', 'long_video', 'vsl'] as const) {
    expect(editorErrors({ ...input, format, mediaIds: [] }, 1, [image])).toEqual({});
  }
});
