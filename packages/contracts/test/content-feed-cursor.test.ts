import { describe, expect, it } from 'vitest';

import { ContentFeedQuerySchema, decodeContentFeedCursor, encodeContentFeedCursor } from '../src/index.js';

const position = { publishOn: '2026-10-20', time: '18:30:00', id: '5f0f3d52-8f7b-4e4b-9d2c-0c1f6a9b7e11' };

describe('the cursor of the content feed', () => {
  it('reads back the position it was made from, and is a url-safe token', () => {
    const cursor = encodeContentFeedCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeContentFeedCursor(cursor)).toEqual(position);
  });

  it('accepts the end of the day, the key of a post with no time', () => {
    expect(decodeContentFeedCursor(encodeContentFeedCursor({ ...position, time: '24:00:00' }))).toEqual({ ...position, time: '24:00:00' });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a b'],
    ['not JSON', 'b2k'],
    ['a day that does not exist', encodeContentFeedCursor({ ...position, publishOn: '2026-02-31' })],
    ['a time past the day', encodeContentFeedCursor({ ...position, time: '25:00:00' })],
    ['an id that is not a UUID', encodeContentFeedCursor({ ...position, id: 'abc' })],
    ['too long', 'A'.repeat(201)]
  ])('refuses a cursor that is %s, without throwing', (_name, cursor) => {
    expect(decodeContentFeedCursor(cursor)).toBeUndefined();
    expect(ContentFeedQuerySchema.safeParse({ cursor }).success).toBe(false);
  });

  it('lets the cursor be absent and refuses a key it does not know', () => {
    expect(ContentFeedQuerySchema.safeParse({}).success).toBe(true);
    expect(ContentFeedQuerySchema.safeParse({ from: '2026-10-01' }).success).toBe(false);
  });
});
