import { describe, expect, it } from 'vitest';

import {
  CreateMediaUploadRequestSchema,
  MediaAltTextSchema,
  MediaFileNameSchema,
  MediaFolderSummarySchema,
  MediaLibraryAssetSchema,
  MediaLibraryListQuerySchema,
  MoveMediaAssetRequestSchema,
  RenameMediaFolderRequestSchema,
  UpdateMediaAssetRequestSchema
} from '../src/index.js';

// Decision 2026-11-11 "a mídia ganha nome, dimensões, texto alternativo, renomear e mover": the name is a label the person gives the
// file, never a path and never part of the object key; the database CHECKs hold the same rules for a caller that skips the route.

const char = (codePoint: number): string => String.fromCodePoint(codePoint);

describe('the name of a media file', () => {
  it.each([
    'foto.png',
    'Vitrine de outubro (final).JPG',
    'relatório-anual_2026.pdf',
    '日本語のファイル.png',
    'a'.repeat(255),
    '😀 festa.png',
    '.hidden'
  ])('accepts %s', (name) => {
    expect(MediaFileNameSchema.safeParse(name).success).toBe(true);
  });

  it('trims the blanks around it', () => {
    expect(MediaFileNameSchema.parse('  foto.png  ')).toBe('foto.png');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['256 characters', 'a'.repeat(256)],
    ['a path with a slash', 'pasta/foto.png'],
    ['a path that climbs', '../../etc/passwd'],
    ['a path with a backslash', 'C:\\Users\\foto.png'],
    ['only dots', '..'],
    ['one dot', '.'],
    ['a NUL', `foto${char(0)}.png`],
    ['a line break', 'foto\n.png'],
    ['a tab', 'foto\t.png'],
    ['a C1 control', `foto${char(0x85)}.png`],
    ['a right-to-left override', `foto${char(0x202e)}gnp.exe`],
    ['a bidi isolate', `foto${char(0x2066)}.png`],
    ['a zero-width space', `foto${char(0x200b)}.png`],
    ['a byte order mark', `foto${char(0xfeff)}.png`],
    ['an Arabic letter mark', `foto${char(0x61c)}.png`],
    ['a line separator', `foto${char(0x2028)}.png`],
    ['a paragraph separator', `foto${char(0x2029)}.png`],
    ['a lone surrogate', `foto${String.fromCharCode(0xd800)}.png`]
  ])('refuses %s', (_label, name) => {
    expect(MediaFileNameSchema.safeParse(name).success).toBe(false);
  });

  it('counts characters, not UTF-16 units: 255 emoji fit and 256 do not', () => {
    expect(MediaFileNameSchema.safeParse('😀'.repeat(255)).success).toBe(true);
    expect(MediaFileNameSchema.safeParse('😀'.repeat(256)).success).toBe(false);
  });
});

describe('the alternative text of a media file', () => {
  it('takes up to 500 characters of one line', () => {
    expect(MediaAltTextSchema.parse('Vitrine da padaria')).toBe('Vitrine da padaria');
    expect(MediaAltTextSchema.safeParse('a'.repeat(500)).success).toBe(true);
    expect(MediaAltTextSchema.safeParse('a'.repeat(501)).success).toBe(false);
  });

  it('reads a blank as none', () => {
    expect(MediaAltTextSchema.parse('   ')).toBeNull();
    expect(MediaAltTextSchema.parse('')).toBeNull();
  });

  it.each([
    ['a line break', 'duas\nlinhas'],
    ['a NUL', `a${char(0)}b`],
    ['a right-to-left override', `a${char(0x202e)}b`],
    ['a zero-width space', `a${char(0x200b)}b`],
    ['an Arabic letter mark', `a${char(0x61c)}b`],
    ['a line separator', `a${char(0x2028)}b`],
    ['a paragraph separator', `a${char(0x2029)}b`]
  ])('refuses %s', (_label, text) => {
    expect(MediaAltTextSchema.safeParse(text).success).toBe(false);
  });
});

describe('the request to start an upload', () => {
  const base = { fileName: 'logo.svg', contentType: 'image/svg+xml', declaredSizeBytes: 1_000 };

  it('takes asLogo, and a name that is a label', () => {
    expect(CreateMediaUploadRequestSchema.safeParse({ ...base, asLogo: true }).success).toBe(true);
    expect(CreateMediaUploadRequestSchema.safeParse({ ...base, asLogo: 'yes' }).success).toBe(false);
    expect(CreateMediaUploadRequestSchema.safeParse({ ...base, fileName: '../logo.svg' }).success).toBe(false);
  });

  it('still sends the client and the folder together', () => {
    const ids = { clientId: '11111111-1111-4111-8111-111111111111', folderId: '22222222-2222-4222-8222-222222222222' };
    expect(CreateMediaUploadRequestSchema.safeParse({ ...base, ...ids }).success).toBe(true);
    expect(CreateMediaUploadRequestSchema.safeParse({ ...base, clientId: ids.clientId }).success).toBe(false);
  });
});

describe('the requests of the library', () => {
  it('needs the name or the alternative text to edit a media, and nothing else', () => {
    expect(UpdateMediaAssetRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateMediaAssetRequestSchema.safeParse({ name: 'novo.png' }).success).toBe(true);
    expect(UpdateMediaAssetRequestSchema.parse({ altText: '  ' })).toEqual({ altText: null });
    expect(UpdateMediaAssetRequestSchema.parse({ altText: null })).toEqual({ altText: null });
    expect(UpdateMediaAssetRequestSchema.safeParse({ name: 'novo.png', folderId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(UpdateMediaAssetRequestSchema.safeParse({ name: 'a/b' }).success).toBe(false);
    expect(UpdateMediaAssetRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('moves to a folder named by id, and takes nothing else', () => {
    expect(MoveMediaAssetRequestSchema.safeParse({ folderId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(MoveMediaAssetRequestSchema.safeParse({ folderId: 'pasta' }).success).toBe(false);
    expect(MoveMediaAssetRequestSchema.safeParse({}).success).toBe(false);
    expect(MoveMediaAssetRequestSchema.safeParse({ folderId: '11111111-1111-4111-8111-111111111111', clientId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
  });

  it('renames a folder with the rules of the name of a folder', () => {
    expect(RenameMediaFolderRequestSchema.safeParse({ name: 'Lançamento de novembro' }).success).toBe(true);
    expect(RenameMediaFolderRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(RenameMediaFolderRequestSchema.safeParse({ name: `a${char(0x202e)}b` }).success).toBe(false);
    expect(RenameMediaFolderRequestSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
    expect(RenameMediaFolderRequestSchema.safeParse({ name: 'ok', parentId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
  });

  it('lists with a search term, a type and a folder', () => {
    expect(MediaLibraryListQuerySchema.parse({ q: '  vitrine ', category: 'logo', page: '2' })).toEqual({ q: 'vitrine', category: 'logo', page: 2 });
    expect(MediaLibraryListQuerySchema.safeParse({ category: 'gif' }).success).toBe(false);
    expect(MediaLibraryListQuerySchema.safeParse({ folderId: 'nope' }).success).toBe(false);
    expect(MediaLibraryListQuerySchema.safeParse({ q: `a${char(0)}b` }).success).toBe(false);
    expect(MediaLibraryListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(MediaLibraryListQuerySchema.safeParse({ other: 1 }).success).toBe(false);
  });
});

describe('what the library answers', () => {
  const asset = {
    id: '11111111-1111-4111-8111-111111111111',
    folderId: '22222222-2222-4222-8222-222222222222',
    folderName: 'Imagens',
    category: 'pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    name: null,
    width: null,
    height: null,
    altText: null,
    videoProcessingStatus: 'not_applicable',
    uploadedBy: null,
    createdAt: '2026-11-11T12:00:00.000Z',
    usageCount: 0
  };

  it('holds the five types and no storage key', () => {
    for (const category of ['image', 'video', 'pdf', 'audio', 'logo']) {
      expect(MediaLibraryAssetSchema.safeParse({ ...asset, category }).success).toBe(true);
    }
    expect(MediaLibraryAssetSchema.safeParse({ ...asset, category: 'gif' }).success).toBe(false);
    expect(MediaLibraryAssetSchema.safeParse({ ...asset, objectKey: 'a/b/original.png' }).success).toBe(false);
  });

  it('describes a folder with its counts by type', () => {
    const folder = {
      id: '22222222-2222-4222-8222-222222222222',
      parentId: null,
      name: 'Imagens',
      isDefault: true,
      createdAt: '2026-11-11T12:00:00.000Z',
      counts: { image: 96, video: 0, pdf: 9, audio: 0, logo: 1 },
      assetCount: 106,
      totalSizeBytes: 1_000,
      lastChangedAt: '2026-11-11T12:00:00.000Z',
      lastUploadedBy: null,
      inUseNow: false
    };
    expect(MediaFolderSummarySchema.safeParse(folder).success).toBe(true);
    expect(MediaFolderSummarySchema.safeParse({ ...folder, counts: { image: 1 } }).success).toBe(false);
  });

  it('says whether a folder is the one in use now, as a yes or a no and never as something missing', () => {
    const folder = {
      id: '22222222-2222-4222-8222-222222222222', parentId: null, name: 'Campanhas', isDefault: false, createdAt: '2026-11-11T12:00:00.000Z',
      counts: { image: 1, video: 0, pdf: 0, audio: 0, logo: 0 }, assetCount: 1, totalSizeBytes: 1_000, lastChangedAt: '2026-11-11T12:00:00.000Z', lastUploadedBy: null
    };
    expect(MediaFolderSummarySchema.safeParse({ ...folder, inUseNow: true }).success).toBe(true);
    expect(MediaFolderSummarySchema.safeParse(folder).success).toBe(false);
    expect(MediaFolderSummarySchema.safeParse({ ...folder, inUseNow: null }).success).toBe(false);
    expect(MediaFolderSummarySchema.safeParse({ ...folder, inUseNow: 'true' }).success).toBe(false);
  });
});
