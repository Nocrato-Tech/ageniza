// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_VIDEO_RECOVERIES, RECOVERY_RESET_SECONDS, RecoverableVideo, VIDEO_RECOVERY_MESSAGES } from './recoverable-video.js';

// jsdom keeps no playback: the position and the play call of the element are a fake the test drives.
const time = new WeakMap<HTMLMediaElement, number>();
const played: Array<{ at: number; src: string }> = [];
const original = {
  currentTime: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime'),
  play: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')
};

beforeEach(() => {
  played.length = 0;
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) { return time.get(this) ?? 0; },
    set(this: HTMLMediaElement, value: number) { time.set(this, value); }
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value(this: HTMLMediaElement) { played.push({ at: this.currentTime, src: this.getAttribute('src') ?? '' }); return Promise.resolve(); }
  });
});

afterEach(() => {
  cleanup();
  if (original.currentTime !== undefined) Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', original.currentTime);
  if (original.play !== undefined) Object.defineProperty(HTMLMediaElement.prototype, 'play', original.play);
});

const LABEL = 'Vídeo: mídia 1 de 1';
const video = (): HTMLVideoElement => screen.getByLabelText(LABEL) as HTMLVideoElement;
const address = (n: number): string => `https://files.test/v.mp4?n=${n}`;

/** The ask of a new address answers a macrotask later, as a request does; the number in the address says which ask it was. */
const slowRefresh = (answer: (ask: number) => string | undefined | Error = (ask) => address(ask + 2)) => {
  let asks = 0;
  return vi.fn(() => new Promise<string | undefined>((resolve, reject) => {
    const ask = asks++;
    setTimeout(() => {
      const value = answer(ask);
      if (value instanceof Error) reject(value);
      else resolve(value);
    }, 0);
  }));
};

const player = (url: string, refresh: () => Promise<string | undefined>) => <RecoverableVideo
  url={url}
  label={LABEL}
  className="player"
  problemClassName="problem"
  refresh={refresh}
/>;

/** The video stops at `at` seconds, as the browser does when the address is refused. */
const refuse = async (at: number, playing: boolean): Promise<void> => {
  const element = video();
  time.set(element, at);
  if (playing) fireEvent.play(element);
  await act(async () => {
    fireEvent.error(element);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

const settledOn = async (n: number): Promise<void> => {
  await waitFor(() => { expect(video().getAttribute('src')).toBe(address(n)); });
};

describe('RecoverableVideo', () => {
  it('asks for a new address when the browser refuses it and goes on from the same second, playing', async () => {
    const refresh = slowRefresh();
    render(player(address(1), refresh));
    await refuse(312.4, true);
    await settledOn(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(played).toEqual([]);
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(312.4);
    expect(played).toEqual([{ at: 312.4, src: address(2) }]);
  });

  it('puts a paused video back in its place without playing it', async () => {
    render(player(address(1), slowRefresh()));
    await refuse(40, false);
    await settledOn(2);
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(40);
    expect(played).toEqual([]);
  });

  it('rebuilds the video even when the new address is the same text', async () => {
    render(player(address(1), slowRefresh(() => address(1))));
    const first = video();
    await refuse(10, true);
    await waitFor(() => { expect(video()).not.toBe(first); });
  });

  it('stops after a few asks in a row, with the message and a button, and does not loop', async () => {
    const refresh = slowRefresh();
    render(player(address(1), refresh));
    for (let round = 0; round < MAX_VIDEO_RECOVERIES; round++) {
      await refuse(100, true);
      await settledOn(round + 2);
    }
    expect(refresh).toHaveBeenCalledTimes(MAX_VIDEO_RECOVERIES);
    await refuse(100, true);
    expect((await screen.findByRole('alert')).textContent).toContain(VIDEO_RECOVERY_MESSAGES.failed);
    expect(screen.getByRole('button', { name: VIDEO_RECOVERY_MESSAGES.retry })).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(refresh).toHaveBeenCalledTimes(MAX_VIDEO_RECOVERIES);
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });

  it('says so when a new address cannot be had, and the button asks again and resumes where it stopped', async () => {
    let failing = true;
    const refresh = slowRefresh((ask) => failing ? undefined : address(ask + 2));
    render(player(address(1), refresh));
    await refuse(75, true);
    expect((await screen.findByRole('alert')).textContent).toContain(VIDEO_RECOVERY_MESSAGES.failed);
    expect(refresh).toHaveBeenCalledTimes(1);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: VIDEO_RECOVERY_MESSAGES.retry }));
    await settledOn(3);
    expect(refresh).toHaveBeenCalledTimes(2);
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(75);
    expect(played).toHaveLength(1);
  });

  it('gives the button a fresh count: after it works, the next expiry is recovered again', async () => {
    const refresh = slowRefresh();
    render(player(address(1), refresh));
    for (let round = 0; round < MAX_VIDEO_RECOVERIES; round++) {
      await refuse(100, true);
      await settledOn(round + 2);
    }
    await refuse(100, true);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: VIDEO_RECOVERY_MESSAGES.retry }));
    await settledOn(MAX_VIDEO_RECOVERIES + 2);
    fireEvent.loadedMetadata(video());
    await refuse(100, true);
    await settledOn(MAX_VIDEO_RECOVERIES + 3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a request that throws as an address that could not be had', async () => {
    render(player(address(1), slowRefresh(() => new Error('429'))));
    await refuse(5, true);
    expect((await screen.findByRole('alert')).textContent).toContain(VIDEO_RECOVERY_MESSAGES.failed);
  });

  it('starts the count over once the recovered video has played on, so a later expiry is recovered too', async () => {
    const refresh = slowRefresh();
    render(player(address(1), refresh));
    const rounds = MAX_VIDEO_RECOVERIES + 2;
    for (let round = 0; round < rounds; round++) {
      const at = 100 + round * 60;
      await refuse(at, true);
      await settledOn(round + 2);
      fireEvent.loadedMetadata(video());
      time.set(video(), at + RECOVERY_RESET_SECONDS + 1);
      fireEvent.timeUpdate(video());
    }
    expect(refresh).toHaveBeenCalledTimes(rounds);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not start the count over for a video that dies right after each recovery', async () => {
    render(player(address(1), slowRefresh()));
    for (let round = 0; round < MAX_VIDEO_RECOVERIES; round++) {
      await refuse(100, true);
      await settledOn(round + 2);
      fireEvent.loadedMetadata(video());
      time.set(video(), 100 + RECOVERY_RESET_SECONDS - 1);
      fireEvent.timeUpdate(video());
    }
    await refuse(100, true);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('asks once for an error that arrives twice while the ask is on the way', async () => {
    const refresh = slowRefresh();
    render(player(address(1), refresh));
    time.set(video(), 9);
    act(() => {
      fireEvent.error(video());
      fireEvent.error(video());
    });
    await settledOn(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  describe('the address the page renews', () => {
    it('is taken while the video sits at its start', () => {
      const view = render(player(address(1), slowRefresh()));
      view.rerender(player(address(7), slowRefresh()));
      expect(video().getAttribute('src')).toBe(address(7));
    });

    it('is not taken under a video that has just started to play', () => {
      const view = render(player(address(1), slowRefresh()));
      fireEvent.play(video());
      view.rerender(player(address(7), slowRefresh()));
      expect(video().getAttribute('src')).toBe(address(1));
    });

    it('is not taken under a video that is playing, and not after it was paused midway', () => {
      const view = render(player(address(1), slowRefresh()));
      const element = video();
      fireEvent.play(element);
      time.set(element, 90);
      view.rerender(player(address(7), slowRefresh()));
      expect(video().getAttribute('src')).toBe(address(1));
      fireEvent.pause(element);
      expect(video().getAttribute('src')).toBe(address(1));
      expect(video().currentTime).toBe(90);
    });
  });
});
