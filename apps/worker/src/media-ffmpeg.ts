import { spawn } from 'node:child_process';

/**
 * Runs `ffmpeg`/`ffprobe` on an untrusted, worker-local file (issue #24). Every invocation:
 *  - allows only the `file`/`pipe` protocols (`-protocol_whitelist`), so a crafted input cannot
 *    make ffmpeg reach out over the network (e.g. an embedded HLS/RTSP reference);
 *  - is bounded by a wall-clock timeout, killed with SIGKILL if it runs past it;
 *  - is killed immediately if the given AbortSignal fires (job timeout or worker shutdown);
 *  - caps how much stdout/stderr it will buffer, so a chatty/broken binary cannot exhaust memory.
 * ffmpeg never has a working directory with untrusted content and is invoked with fixed,
 * application-authored arguments only -- nothing here interpolates request data into a shell.
 */
export interface RunMediaBinaryOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export class MediaBinaryError extends Error {
  constructor(
    message: string,
    readonly code: 'TIMEOUT' | 'ABORTED' | 'EXIT_FAILURE' | 'SPAWN_FAILURE'
  ) {
    super(message);
    this.name = 'MediaBinaryError';
  }
}

const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

/** setTimeout fires at once past this; no deadline of a step comes near it. */
const MAX_TIMER_MS = 2_147_483_647;

const PROTOCOL_WHITELIST_ARGS = ['-protocol_whitelist', 'file,pipe'] as const;

const runBinary = (
  binary: string,
  args: readonly string[],
  options: RunMediaBinaryOptions
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell: args are passed as an argv array, never interpolated into a command string.
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    // The deadline is ours, not the spawn option's: a process that ends by SIGKILL or SIGTERM for another reason (the kernel out of
    // memory, an operator) did not run out of time, and TIMEOUT ends the job with no new attempt.
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.min(options.timeoutMs, MAX_TIMER_MS));

    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new MediaBinaryError(`Failed to start ${binary}: ${error.message}`, 'SPAWN_FAILURE'));
    });

    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(new MediaBinaryError(`${binary} was aborted before it finished.`, 'ABORTED'));
        return;
      }
      if (timedOut) {
        reject(new MediaBinaryError(`${binary} did not finish within ${options.timeoutMs}ms and was killed.`, 'TIMEOUT'));
        return;
      }
      if (exitCode !== 0) {
        reject(new MediaBinaryError(`${binary} ${signal === null ? `exited with code ${exitCode ?? 'null'}` : `was ended by ${signal}`}.`, 'EXIT_FAILURE'));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export interface VideoProbeResult {
  readonly durationSeconds: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
}

interface FfprobeStream {
  readonly width?: number;
  readonly height?: number;
  readonly codec_type?: string;
  readonly tags?: { readonly rotate?: string };
  readonly side_data_list?: readonly { readonly rotation?: number | string }[];
}

interface FfprobeOutput {
  readonly format?: { readonly duration?: string };
  readonly streams?: readonly FfprobeStream[];
}

// A phone video is stored sideways with a rotation flag: ffmpeg turns it upright, so the size people see swaps width and height.
const turnsAQuarter = (stream: FfprobeStream): boolean => {
  const rotation = Number(stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? stream.tags?.rotate);
  return Number.isFinite(rotation) && rotation % 90 === 0 && Math.abs(rotation / 90) % 2 === 1;
};

/** Reads duration and the first video stream's dimensions, as displayed, without decoding any frame. */
export const probeVideo = async (filePath: string, options: RunMediaBinaryOptions): Promise<VideoProbeResult> => {
  // ffprobe (unlike ffmpeg) has no `-nostdin` option; it never reads from stdin in the first
  // place, so there is nothing to disable here.
  const { stdout } = await runBinary('ffprobe', [
    '-hide_banner',
    '-v', 'error',
    ...PROTOCOL_WHITELIST_ARGS,
    '-show_entries', 'format=duration:stream=width,height,codec_type:stream_side_data=rotation:stream_tags=rotate',
    '-of', 'json',
    filePath
  ], options);

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new MediaBinaryError('ffprobe did not return valid JSON.', 'EXIT_FAILURE');
  }
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? '');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaBinaryError('ffprobe did not report a valid duration.', 'EXIT_FAILURE');
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (videoStream !== undefined && turnsAQuarter(videoStream)) {
    return { durationSeconds, width: videoStream.height, height: videoStream.width };
  }
  return { durationSeconds, width: videoStream?.width, height: videoStream?.height };
};

export interface GenerateThumbnailOptions extends RunMediaBinaryOptions {
  readonly widthPixels: number;
  /** Seconds into the clip to grab the frame from; clamped to the source duration by the caller. */
  readonly atSeconds: number;
}

/** Extracts one JPEG frame, scaled to `widthPixels` wide (height keeps aspect ratio, forced even). */
export const generateThumbnail = async (
  inputPath: string,
  outputPath: string,
  options: GenerateThumbnailOptions
): Promise<void> => {
  await runBinary('ffmpeg', [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-v', 'error',
    ...PROTOCOL_WHITELIST_ARGS,
    '-ss', options.atSeconds.toFixed(3),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${options.widthPixels}:-2`,
    '-f', 'image2',
    outputPath
  ], options);
};

export interface GeneratePreviewOptions extends RunMediaBinaryOptions {
  readonly maxHeightPixels: number;
  readonly maxOutputBytes: number;
}

/** Encodes an H.264/AAC MP4 preview, capped at `maxHeightPixels` tall (never upscaled) and
 * `maxOutputBytes` (ffmpeg's own `-fs`, which stops muxing once the limit is reached). */
export const generatePreview = async (
  inputPath: string,
  outputPath: string,
  options: GeneratePreviewOptions
): Promise<void> => {
  await runBinary('ffmpeg', [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-v', 'error',
    ...PROTOCOL_WHITELIST_ARGS,
    '-i', inputPath,
    '-vf', `scale=-2:'min(${options.maxHeightPixels},ih)'`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-fs', String(options.maxOutputBytes),
    outputPath
  ], options);
};
