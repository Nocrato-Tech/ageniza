import { describe, expect, it } from 'vitest';

import { PortalContentMediaItemSchema } from '../src/index.js';

const id = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('PortalContentMediaItemSchema', () => {
  it.each(['image', 'video'] as const)('accepts a %s item', (kind) => {
    expect(PortalContentMediaItemSchema.parse({ id, position: 1, kind })).toEqual({ id, position: 1, kind });
  });

  it.each([{ id, position: 1 }, { id, position: 1, kind: 'audio' }, { id, position: 1, kind: 'image', extra: true }])('refuses %j', (item) => {
    expect(PortalContentMediaItemSchema.safeParse(item).success).toBe(false);
  });
});
