import { describe, expect, it } from 'vitest';

import { parseHealthResponse } from './health.js';

describe('health contract consumption', () => {
  it('validates the public API health payload before using it', () => {
    expect(parseHealthResponse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(() => parseHealthResponse({ status: 'degraded' })).toThrow();
  });
});
