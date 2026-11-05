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

class TestBinaryError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** The job with its collaborators replaced: what the ffmpeg steps do is chosen by each test, and the calls on the row are recorded. */
const loadJob = async (steps: { probe?: () => Promise<unknown>; thumbnail?: () => Promise<void>; preview?: () => Promise<void>; download?: (options: { signal: AbortSignal }) => Promise<void> }) => {
  vi.resetModules();
  const row = { failed: [] as string[], retrying: 0, ready: 0 };
  vi.doMock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    stat: vi.fn(async () => ({ size: 10 }))
  }));
  vi.doMock('./media-ffmpeg.js', () => ({
    MediaBinaryError: TestBinaryError,
    probeVideo: vi.fn(steps.probe ?? (async () => ({ durationSeconds: 60, width: 1920, height: 1080 }))),
    generateThumbnail: vi.fn(steps.thumbnail ?? (async () => undefined)),
    generatePreview: vi.fn(steps.preview ?? (async () => undefined))
  }));
  vi.doMock('./media-repository.js', () => ({
    lockConfirmedVideoAsset: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000002', agency_id: '00000000-0000-4000-8000-000000000001', object_key: 'k', video_processing_status: 'pending' })),
    markVideoProcessingStarted: vi.fn(async () => undefined),
    markVideoProcessingReady: vi.fn(async () => { row.ready += 1; }),
    markVideoProcessingFailed: vi.fn(async (_transaction: unknown, _id: string, reason: string) => { row.failed.push(reason); }),
    markVideoProcessingRetrying: vi.fn(async () => { row.retrying += 1; })
  }));
  vi.doMock('@ageniza/database', () => ({
    createVerifiedUserClaims: vi.fn(() => ({})),
    withAuthenticatedUserTransaction: vi.fn(async (_db: unknown, _claims: unknown, work: (t: unknown) => unknown) => work({}))
  }));
  const { mediaVideoProcessingJob: build } = await import('./media-video-job.js');
  const storage = { downloadToFile: vi.fn(steps.download ?? (async () => undefined)), uploadFile: vi.fn(async () => undefined), deleteObject: vi.fn(async () => undefined) };
  const definition = build({
    database: {} as never,
    storage: storage as never,
    config: { ...config, maxDurationSeconds: 1_800, thumbnailWidthPixels: 160, previewMaxHeightPixels: 480, previewMaxOutputBytes: 1_000_000 },
    tempRootDir: tmpdir()
  });
  const logger = { info: vi.fn(), error: vi.fn() };
  const run = (attempt: number, signal: AbortSignal = new AbortController().signal) => definition.handler(
    { id: 'j', name: definition.name, attempt, payload: { assetId: '00000000-0000-4000-8000-000000000002', agencyId: '00000000-0000-4000-8000-000000000001', actorUserId: '00000000-0000-4000-8000-000000000003' } },
    { logger: logger as never, signal }
  );
  return { run, row, storage, logger };
};

const unmock = (): void => {
  vi.doUnmock('./media-ffmpeg.js');
  vi.doUnmock('./media-repository.js');
  vi.doUnmock('@ageniza/database');
  vi.doUnmock('node:fs/promises');
};

describe('a video that ran out of time is not tried again', () => {
  it('records the time-out as the final failure on the first attempt and ends the job without an error, so the queue does not repeat it', async () => {
    const job = await loadJob({ preview: async () => { throw new TestBinaryError('TIMEOUT'); } });
    await expect(job.run(1)).resolves.toBeUndefined();
    expect(job.row.failed).toEqual(['processing_timed_out']);
    expect(job.row.retrying).toBe(0);
    expect(job.row.ready).toBe(0);
    expect(job.logger.error).toHaveBeenCalledTimes(1);
    unmock();
  });

  it('still returns the asset to pending and raises the error for a failure that may pass, while a retry is left', async () => {
    const job = await loadJob({ preview: async () => { throw new TestBinaryError('EXIT'); } });
    await expect(job.run(1)).rejects.toThrow();
    expect(job.row.failed).toEqual([]);
    expect(job.row.retrying).toBe(1);
    unmock();
  });

  it('treats the end of the budget of the whole job like the time-out of a step', async () => {
    const budget = new AbortController();
    const real = AbortSignal.timeout.bind(AbortSignal);
    let first = true;
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
      if (first) { first = false; return budget.signal; }
      return real(milliseconds);
    });
    try {
      let heard: boolean | undefined;
      const job = await loadJob({
        download: async ({ signal }) => {
          // The budget of the job ends while the file is coming down: what storage was handed must have heard it.
          budget.abort();
          heard = signal.aborted;
          throw new DOMException('aborted', 'AbortError');
        }
      });
      await expect(job.run(1)).resolves.toBeUndefined();
      expect(heard).toBe(true);
      expect(job.row.failed).toEqual(['processing_timed_out']);
      expect(job.row.retrying).toBe(0);
      expect(spy.mock.calls[0]?.[0]).toBe(mediaVideoHandlerTimeoutSeconds({ ...config }) * 1_000);
    } finally {
      spy.mockRestore();
      unmock();
    }
  });

  it('does not take a shutdown of the worker for a time-out: that one is still retried', async () => {
    const shutdown = new AbortController();
    const job = await loadJob({
      download: async () => {
        shutdown.abort();
        throw new DOMException('aborted', 'AbortError');
      }
    });
    await expect(job.run(1, shutdown.signal)).rejects.toThrow();
    expect(job.row.failed).toEqual([]);
    expect(job.row.retrying).toBe(1);
    unmock();
  });
});
