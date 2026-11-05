import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@ageniza/ui';

/** How many times in a row the player asks for a new address after the browser refused one. */
export const MAX_VIDEO_RECOVERIES = 3;

/** A recovered video must play this many seconds past where it resumed before the count starts over. */
export const RECOVERY_RESET_SECONDS = 5;

/** A video at the very start may take a new address without losing anything. */
const AT_THE_START_SECONDS = 0.5;

export const VIDEO_RECOVERY_MESSAGES = {
  failed: 'Não foi possível retomar o vídeo.',
  retry: 'Tentar de novo'
} as const;

interface Resume {
  readonly at: number;
  readonly play: boolean;
}

/**
 * A video whose signed address lives minutes: when the browser refuses it (a range request made after it expired), the
 * player asks for a new address, puts the video back where it was and plays on if it was playing. It asks at most
 * `MAX_VIDEO_RECOVERIES` times in a row, so an address that is bad for another reason stops with a message and a button,
 * never in a loop; a recovered video that plays on for `RECOVERY_RESET_SECONDS` starts the count over for the next expiry.
 *
 * `url` is the current address of the media. A new one is taken only while the video sits at its start, never under a
 * video that is playing or paused midway (a new `src` would restart it). `refresh` asks for a new address and answers it
 * (or `undefined` when it could not). Every ask goes through the caller's own request, so any rate limit stays where it was.
 */
export function RecoverableVideo({ url, poster, label, className, problemClassName, refresh, refreshing = false }: {
  url: string;
  poster?: string | undefined;
  label: string;
  className: string;
  problemClassName: string;
  refresh: () => Promise<string | undefined>;
  refreshing?: boolean;
}): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState(url);
  // Changes with every recovery so the element is rebuilt even when the new address is the same text.
  const [generation, setGeneration] = useState(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const resume = useRef<Resume | undefined>(undefined);
  const lastTime = useRef(0);
  const recoveries = useRef(0);
  const recoveredAt = useRef<number | undefined>(undefined);
  const playing = useRef(false);
  const asking = useRef(false);
  const latestUrl = useRef(url);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const adoptLatest = useCallback((): void => {
    const atTheStart = !playing.current && (videoRef.current?.currentTime ?? 0) < AT_THE_START_SECONDS;
    if (atTheStart && resume.current === undefined) setSrc(latestUrl.current);
  }, []);

  useEffect(() => {
    latestUrl.current = url;
    adoptLatest();
  }, [url, adoptLatest]);

  const recover = useCallback(async (at: number, play: boolean): Promise<void> => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    recoveries.current += 1;
    let fresh: string | undefined;
    try {
      fresh = await refresh();
    } catch {
      fresh = undefined;
    }
    asking.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (fresh === undefined) {
      resume.current = { at, play };
      setFailed(true);
      return;
    }
    resume.current = { at, play };
    playing.current = false;
    recoveredAt.current = at;
    setFailed(false);
    setSrc(fresh);
    setGeneration((value) => value + 1);
  }, [refresh]);

  const onError = (): void => {
    const video = videoRef.current;
    const at = video !== null && video.currentTime > 0 ? video.currentTime : (resume.current?.at ?? lastTime.current);
    // A video that was recovered and fails again before its metadata is paused and at zero, but it was playing before: that is kept.
    const play = playing.current || (video !== null && !video.paused) || resume.current?.play === true;
    if (recoveries.current >= MAX_VIDEO_RECOVERIES) {
      resume.current = { at, play };
      setFailed(true);
      return;
    }
    void recover(at, play);
  };

  const onLoadedMetadata = (): void => {
    const video = videoRef.current;
    const pending = resume.current;
    if (video === null || pending === undefined) return;
    resume.current = undefined;
    if (pending.at > 0) video.currentTime = pending.at;
    if (pending.play) void Promise.resolve(video.play()).catch(() => undefined);
  };

  const onTimeUpdate = (): void => {
    const video = videoRef.current;
    if (video === null) return;
    lastTime.current = video.currentTime;
    if (recoveredAt.current !== undefined && video.currentTime >= recoveredAt.current + RECOVERY_RESET_SECONDS) {
      recoveries.current = 0;
      recoveredAt.current = undefined;
    }
  };

  if (failed) {
    return <div className={problemClassName} role="alert">
      <p>{VIDEO_RECOVERY_MESSAGES.failed}</p>
      <Button
        variant="secondary"
        loading={busy || refreshing}
        onClick={() => {
          recoveries.current = 0;
          void recover(resume.current?.at ?? lastTime.current, resume.current?.play ?? false);
        }}
      >{VIDEO_RECOVERY_MESSAGES.retry}</Button>
    </div>;
  }

  return <video
    key={generation}
    ref={videoRef}
    className={className}
    src={src}
    poster={poster}
    controls
    playsInline
    preload="metadata"
    aria-label={label}
    onError={onError}
    onLoadedMetadata={onLoadedMetadata}
    onTimeUpdate={onTimeUpdate}
    onPlay={() => { playing.current = true; }}
    onPause={() => { playing.current = false; adoptLatest(); }}
    onEnded={() => { playing.current = false; adoptLatest(); }}
  />;
}
