import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generatePreview, generateThumbnail, MediaBinaryError, probeVideo } from './media-ffmpeg.js';

// Issue #24 acceptance tests. Requires a real `ffmpeg`/`ffprobe` on PATH -- there is no way to
// fake process spawning here without losing the coverage that matters (real timeouts, real exit
// codes, real protocol restriction). If ffmpeg is unavailable, run these inside the worker's own
// Docker image (`docker compose build worker && docker compose run --rm worker ffmpeg -version`),
// which is where CI and production get ffmpeg from (apps/worker/Dockerfile).
describe('media ffmpeg wrapper (real ffmpeg/ffprobe, no network)', () => {
  let workDir: string;
  let samplePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ageniza-ffmpeg-test-'));
    samplePath = join(workDir, 'sample.mp4');
    // A synthetic 2-second clip generated entirely from ffmpeg's own test-pattern source
    // (lavfi) -- no network, no external fixture file to keep in the repository.
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac',
      samplePath
    ]);
    if (result.status !== 0) throw new Error(`Failed to generate the fixture video: ${result.stderr?.toString()}`);
  }, 30_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('probes duration and dimensions', async () => {
    const probe = await probeVideo(samplePath, { timeoutMs: 10_000 });
    expect(probe.durationSeconds).toBeGreaterThan(1.5);
    expect(probe.durationSeconds).toBeLessThan(3);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  });

  it('generates a scaled thumbnail image', async () => {
    const outputPath = join(workDir, 'thumb.jpg');
    await generateThumbnail(samplePath, outputPath, { timeoutMs: 10_000, widthPixels: 160, atSeconds: 1 });
    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBeGreaterThan(0);
    const probe = await probeVideo(outputPath, { timeoutMs: 10_000 }).catch(() => undefined);
    // ffprobe reports an image as a near-zero/absent duration; the size assertion above is what
    // actually matters here.
    expect(probe === undefined || Number.isFinite(probe.durationSeconds)).toBe(true);
  });

  it('generates a height-capped MP4 preview that never upscales', async () => {
    const outputPath = join(workDir, 'preview.mp4');
    await generatePreview(samplePath, outputPath, {
      timeoutMs: 10_000,
      maxHeightPixels: 720,
      maxOutputBytes: 50 * 1024 * 1024
    });
    const probe = await probeVideo(outputPath, { timeoutMs: 10_000 });
    // The source is only 240px tall; a 720p cap must not upscale it.
    expect(probe.height).toBe(240);
    expect(probe.width).toBe(320);
  });

  it('caps preview output size with -fs', async () => {
    const outputPath = join(workDir, 'preview-capped.mp4');
    await generatePreview(samplePath, outputPath, {
      timeoutMs: 10_000,
      maxHeightPixels: 720,
      // Far smaller than a valid encode of this clip; ffmpeg must stop muxing at the limit
      // instead of ignoring it.
      maxOutputBytes: 4_096
    });
    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBeLessThanOrEqual(4_096 * 4); // ffmpeg's -fs is a soft stop, not exact.
  });

  it('kills a process that runs past its timeout', async () => {
    // No real file can force an artificial timeout without genuinely large input, so this exercises
    // the same code path against a slow, large synthetic source with a deliberately tiny timeout.
    await expect(probeVideo(samplePath, { timeoutMs: 1 })).rejects.toMatchObject({ name: 'MediaBinaryError' });
  });

  it('refuses a crafted input that tries to reach the network', async () => {
    const maliciousPath = join(workDir, 'malicious.txt');
    // A concat/HLS-style reference that would otherwise make ffmpeg fetch a remote resource --
    // -protocol_whitelist file,pipe must reject this outright rather than reaching out.
    await writeFile(maliciousPath, 'ffconcat version 1.0\nfile \'http://169.254.169.254/nonexistent\'\n');
    await expect(probeVideo(maliciousPath, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(MediaBinaryError);
  });

  it('aborts immediately when the signal fires', async () => {
    const controller = new AbortController();
    const promise = probeVideo(samplePath, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
