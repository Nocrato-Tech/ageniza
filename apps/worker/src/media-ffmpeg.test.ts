import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A binary that ends by a signal is not always a binary that ran out of time. TIMEOUT ends the job at once, with no retry, so it
// must mean one thing: the deadline of that step passed. A kernel that kills ffmpeg for memory (SIGKILL after a few seconds of a
// 120 s deadline) is a failure that may pass on another attempt. No real time and no real binary: the child process is a fake.
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: Array<string | number | undefined> = [];

  kill(signal?: string | number): boolean {
    this.kills.push(signal);
    // The process dies of the signal it was sent.
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

let child: FakeChild;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => child)
}));

const { probeVideo } = await import('./media-ffmpeg.js');

beforeEach(() => {
  child = new FakeChild();
});

afterEach(() => {
  vi.useRealTimers();
});

const outcome = (promise: Promise<unknown>): Promise<{ code: string } | 'resolved'> =>
  promise.then(() => 'resolved' as const, (error: { code: string }) => ({ code: error.code }));

const probeOutput = async (stream: Record<string, unknown>) => {
  const result = probeVideo('video.mp4', { timeoutMs: 120_000 });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '2.000000' }, streams: [{ codec_type: 'video', ...stream }] })));
  child.emit('exit', 0, null);
  return result;
};

describe('the size a video is probed with', () => {
  it('is the stored size when the video has no rotation', async () => {
    expect(await probeOutput({ width: 320, height: 240 })).toMatchObject({ width: 320, height: 240 });
    expect(await probeOutput({ width: 320, height: 240, side_data_list: [{ rotation: 0 }] })).toMatchObject({ width: 320, height: 240 });
    expect(await probeOutput({ width: 320, height: 240, side_data_list: [{ rotation: 180 }] })).toMatchObject({ width: 320, height: 240 });
  });

  it.each([
    ['a display matrix of 90', { side_data_list: [{ rotation: 90 }] }],
    ['a display matrix of -90', { side_data_list: [{ rotation: -90 }] }],
    ['a display matrix of 270', { side_data_list: [{ rotation: 270 }] }],
    ['a rotate tag of 90, as older files carry it', { tags: { rotate: '90' } }],
    ['a rotate tag of 270', { tags: { rotate: '270' } }]
  ])('is the upright size, width and height swapped, with %s', async (_label, rotation) => {
    expect(await probeOutput({ width: 1920, height: 1080, ...rotation })).toMatchObject({ width: 1080, height: 1920 });
  });

  it('asks ffprobe for the rotation, in both places it is written', async () => {
    const { spawn } = await import('node:child_process');
    await probeOutput({ width: 1, height: 1 });
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as readonly string[];
    expect(args[args.indexOf('-show_entries') + 1]).toBe('format=duration:stream=width,height,codec_type:stream_side_data=rotation:stream_tags=rotate');
  });

  it('is undefined when the file has no video stream', async () => {
    const result = probeVideo('audio.mp4', { timeoutMs: 120_000 });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: '2.000000' }, streams: [{ codec_type: 'audio' }] })));
    child.emit('exit', 0, null);
    expect(await result).toEqual({ durationSeconds: 2, width: undefined, height: undefined });
  });
});

describe('why a media binary ended', () => {
  it.each(['SIGKILL', 'SIGTERM', 'SIGSEGV'] as const)('is an EXIT_FAILURE, which may be tried again, when %s arrives long before the deadline', async (signal) => {
    vi.useFakeTimers();
    const result = outcome(probeVideo('video.mp4', { timeoutMs: 120_000 }));
    // The kernel (out of memory) or an operator ends it 3.8 s into a 120 s deadline.
    await vi.advanceTimersByTimeAsync(3_800);
    child.emit('exit', null, signal);
    expect(await result).toEqual({ code: 'EXIT_FAILURE' });
  });

  it('is a TIMEOUT only when the deadline of the step passed: the process is killed then and says so', async () => {
    vi.useFakeTimers();
    const result = outcome(probeVideo('video.mp4', { timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(child.kills).toEqual(['SIGKILL']);
    expect(await result).toEqual({ code: 'TIMEOUT' });
  });

  it('is ABORTED, never TIMEOUT, when the signal of the job aborts it', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = outcome(probeVideo('video.mp4', { timeoutMs: 120_000, signal: controller.signal }));
    controller.abort();
    expect(await result).toEqual({ code: 'ABORTED' });
  });

  it('is an EXIT_FAILURE on a plain non-zero exit, and the process that ends in time is not killed by the deadline later', async () => {
    vi.useFakeTimers();
    const result = outcome(probeVideo('video.mp4', { timeoutMs: 1_000 }));
    child.emit('exit', 1, null);
    expect(await result).toEqual({ code: 'EXIT_FAILURE' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kills).toEqual([]);
  });
});
