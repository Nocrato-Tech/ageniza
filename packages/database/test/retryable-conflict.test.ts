import { describe, expect, it } from 'vitest';

import { isRetryableConflict } from '../src/index.js';

describe('retryable database conflicts', () => {
  it('treats a deadlock and a serialization failure as a lost race, and nothing else', () => {
    expect(isRetryableConflict({ code: '40P01' })).toBe(true);
    expect(isRetryableConflict({ code: '40001' })).toBe(true);
    for (const other of [{ code: 'A0042' }, { code: '23505' }, { code: '42501' }, { code: '57014' }, new Error('x'), null, undefined, 'x']) {
      expect(isRetryableConflict(other), String(other)).toBe(false);
    }
  });
});
