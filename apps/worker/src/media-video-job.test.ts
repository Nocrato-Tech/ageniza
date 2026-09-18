import { describe, expect, it } from 'vitest';

import { mediaVideoExpireInSeconds, mediaVideoHandlerTimeoutSeconds } from './media-video-job.js';

describe('media video job timeout budget', () => {
  it('budgets ffprobe plus both ffmpeg calls before pg-boss expiry', () => {
    expect(mediaVideoHandlerTimeoutSeconds(240)).toBe(840);
    expect(mediaVideoExpireInSeconds(240)).toBe(900);
  });
});
