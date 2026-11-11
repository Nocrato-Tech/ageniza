import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';

export interface ReadGate {
  /** Reads that matched, counted when the request leaves, held or not. */
  reads: number;
  /** Answers every matching read with this instead of the real one, until cleared. */
  fail: (() => Response) | null;
  /** Matching reads wait for this before they are answered. */
  hold: Promise<void> | null;
}

/** Wraps a `fetch`: counts the `GET`s that match, can fail them and can hold them; everything else goes through untouched. */
export const gateReads = (base: typeof fetch, matches: (url: URL) => boolean): { impl: typeof fetch; gate: ReadGate } => {
  const gate: ReadGate = { reads: 0, fail: null, hold: null };
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if ((init?.method ?? 'GET') === 'GET' && matches(url)) {
      gate.reads += 1;
      if (gate.hold !== null) await gate.hold;
      if (gate.fail !== null) return gate.fail();
    }
    return base(input, init);
  };
  return { impl, gate };
};

export const serverFailure = (): Response =>
  new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }), { status: 500, headers: { 'content-type': 'application/json' } });

/**
 * The failure is on screen. Holds the next read and clicks "Tentar de novo" twice: while the read repeats the failure and its button
 * stay mounted, busy, with the focus, and the second click sends nothing. It returns once the held read was let go; the caller
 * then checks that the data replaced the failure.
 */
export const retryWhileHeld = async (failure: HTMLElement, gate: ReadGate): Promise<void> => {
  let release: () => void = () => undefined;
  gate.hold = new Promise<void>((resolve) => { release = resolve; });
  gate.fail = null;
  const retry = within(failure).getByRole('button', { name: 'Tentar de novo' });
  retry.focus();
  const before = gate.reads;
  fireEvent.click(retry);
  await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('true'));
  expect(retry.isConnected).toBe(true);
  expect(failure.isConnected).toBe(true);
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(gate.reads).toBe(before + 1);
  expect(document.activeElement).toBe(retry);
  release();
};
