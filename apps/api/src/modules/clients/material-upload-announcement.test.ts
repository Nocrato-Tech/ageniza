import { describe, expect, it } from 'vitest';

import { announcementBody } from './material-upload-announcement.js';

describe('the text of the announcement of a batch', () => {
  it.each([
    [{ images: 3, audios: 0 }, 'enviou 3 fotos'],
    [{ images: 1, audios: 0 }, 'enviou 1 foto'],
    [{ images: 0, audios: 1 }, 'enviou 1 áudio'],
    [{ images: 0, audios: 2 }, 'enviou 2 áudios'],
    [{ images: 2, audios: 1 }, 'enviou 2 fotos e 1 áudio'],
    [{ images: 1, audios: 2 }, 'enviou 1 foto e 2 áudios']
  ])('words %j as "%s"', (counts, text) => {
    expect(announcementBody(counts)).toBe(text);
  });

  it('refuses to announce nothing', () => {
    expect(() => announcementBody({ images: 0, audios: 0 })).toThrow();
  });
});
