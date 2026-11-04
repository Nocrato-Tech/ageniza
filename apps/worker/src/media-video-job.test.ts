import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { mediaPreviewTimeoutSeconds, mediaVideoExpireInSeconds, mediaVideoHandlerTimeoutSeconds } from './media-video-job.js';

const config = { ffmpegTimeoutSeconds: 240, timeoutPerMediaSecond: 0.5, maxTimeoutSeconds: 1_200 };

describe('media preview timeout from the probed duration', () => {
  it('grows with the duration', () => {
    expect(mediaPreviewTimeoutSeconds(1_800, config)).toBe(900);
    expect(mediaPreviewTimeoutSeconds(1_000.2, config)).toBe(501);
  });

  it('never goes under the floor', () => {
    expect(mediaPreviewTimeoutSeconds(10, config)).toBe(240);
    expect(mediaPreviewTimeoutSeconds(480, config)).toBe(240);
    expect(mediaPreviewTimeoutSeconds(482, config)).toBe(241);
  });

  it('never goes over the ceiling', () => {
    expect(mediaPreviewTimeoutSeconds(3_600, config)).toBe(1_200);
    expect(mediaPreviewTimeoutSeconds(2_400, config)).toBe(1_200);
    expect(mediaPreviewTimeoutSeconds(2_398, config)).toBe(1_199);
  });

  it('keeps the floor when the ceiling was set under it', () => {
    expect(mediaPreviewTimeoutSeconds(3_600, { ...config, maxTimeoutSeconds: 100 })).toBe(240);
  });
});

describe('media video job timeout budget', () => {
  it('budgets probe, thumbnail, a preview at the ceiling and the transfers before pg-boss expiry', () => {
    expect(mediaVideoHandlerTimeoutSeconds(config)).toBe(240 * 2 + 1_200 + 120);
    expect(mediaVideoExpireInSeconds(config)).toBe(240 * 2 + 1_200 + 120 + 60);
  });

  it('covers the longest preview the duration limit can ask for', () => {
    const longest = mediaPreviewTimeoutSeconds(1_800, config);
    expect(mediaVideoHandlerTimeoutSeconds(config)).toBeGreaterThan(240 * 2 + longest);
    expect(mediaVideoExpireInSeconds(config)).toBeGreaterThan(mediaVideoHandlerTimeoutSeconds(config));
  });
});

describe('media video job wiring of the preview timeout', () => {
  it('hands the encode the duration-based timeout and the probe and thumbnail the floor', async () => {
    vi.resetModules();
    const calls: { probe?: number; thumbnail?: number; preview?: number } = {};
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      stat: vi.fn(async () => ({ size: 10 }))
    }));
    vi.doMock('./media-ffmpeg.js', () => ({
      MediaBinaryError: class extends Error {},
      probeVideo: vi.fn(async (_path: string, options: { timeoutMs: number }) => {
        calls.probe = options.timeoutMs;
        return { durationSeconds: 1_800, width: 1920, height: 1080 };
      }),
      generateThumbnail: vi.fn(async (_i: string, _o: string, options: { timeoutMs: number }) => {
        calls.thumbnail = options.timeoutMs;
      }),
      generatePreview: vi.fn(async (_i: string, _o: string, options: { timeoutMs: number }) => {
        calls.preview = options.timeoutMs;
      })
    }));
    vi.doMock('./media-repository.js', () => ({
      lockConfirmedVideoAsset: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000002', agency_id: '00000000-0000-4000-8000-000000000001', object_key: 'k', video_processing_status: 'pending' })),
      markVideoProcessingStarted: vi.fn(async () => undefined),
      markVideoProcessingReady: vi.fn(async () => undefined),
      markVideoProcessingFailed: vi.fn(async () => undefined),
      markVideoProcessingRetrying: vi.fn(async () => undefined)
    }));
    vi.doMock('@ageniza/database', () => ({
      createVerifiedUserClaims: vi.fn(() => ({})),
      withAuthenticatedUserTransaction: vi.fn(async (_db: unknown, _claims: unknown, work: (t: unknown) => unknown) => work({}))
    }));
    const { mediaVideoProcessingJob: build } = await import('./media-video-job.js');
    const storage = { downloadToFile: vi.fn(async () => undefined), uploadFile: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined) };
    const definition = build({
      database: {} as never,
      storage: storage as never,
      config: { ...config, maxDurationSeconds: 1_800, thumbnailWidthPixels: 160, previewMaxHeightPixels: 480, previewMaxOutputBytes: 1_000_000 },
      tempRootDir: tmpdir()
    });
    const logger = { info: vi.fn() } as never;
    await definition.handler(
      { id: 'j', name: definition.name, attempt: 1, payload: { assetId: '00000000-0000-4000-8000-000000000002', agencyId: '00000000-0000-4000-8000-000000000001', actorUserId: '00000000-0000-4000-8000-000000000003' } },
      { logger, signal: new AbortController().signal }
    );
    expect(calls).toEqual({ probe: 240_000, thumbnail: 240_000, preview: 900_000 });
    vi.doUnmock('./media-ffmpeg.js');
    vi.doUnmock('./media-repository.js');
    vi.doUnmock('@ageniza/database');
    vi.doUnmock('node:fs/promises');
  });
});
