import { describe, expect, it } from 'vitest';

import { PortalContentInProductionSchema, PortalContentMediaItemSchema, PortalContentOpenDetailSchema, PortalContentOpenListItemSchema } from '../src/index.js';

const id = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('PortalContentMediaItemSchema', () => {
  it.each(['image', 'video'] as const)('accepts a %s item', (kind) => {
    expect(PortalContentMediaItemSchema.parse({ id, position: 1, kind })).toEqual({ id, position: 1, kind });
  });

  it.each([{ id, position: 1 }, { id, position: 1, kind: 'audio' }, { id, position: 1, kind: 'image', extra: true }])('refuses %j', (item) => {
    expect(PortalContentMediaItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('the file that serves as the cover of the card (issue #606)', () => {
  const open = { id, title: 'Post', platform: 'instagram', format: 'image', publishOn: '2026-10-20', publishAtTime: null, status: 'approved', coverAssetId: null, publishedOn: null };

  it('is an id or null in the open item of the list, and is required', () => {
    expect(PortalContentOpenListItemSchema.safeParse({ ...open, thumbnailAssetId: id }).success).toBe(true);
    expect(PortalContentOpenListItemSchema.safeParse({ ...open, thumbnailAssetId: null }).success).toBe(true);
    expect(PortalContentOpenListItemSchema.safeParse(open).success).toBe(false);
    expect(PortalContentOpenListItemSchema.safeParse({ ...open, thumbnailAssetId: 'x' }).success).toBe(false);
  });

  it('is never in a content in production, and never repeated by the post', () => {
    const production = { id, title: 'Post', format: 'image', publishOn: '2026-10-20', status: 'in_production' };
    expect(PortalContentInProductionSchema.safeParse(production).success).toBe(true);
    expect(PortalContentInProductionSchema.safeParse({ ...production, thumbnailAssetId: id }).success).toBe(false);
    const detail = { ...open, caption: null, revision: 1, media: [] };
    expect(PortalContentOpenDetailSchema.safeParse(detail).success).toBe(true);
    expect(PortalContentOpenDetailSchema.safeParse({ ...detail, thumbnailAssetId: id }).success).toBe(false);
  });
});

