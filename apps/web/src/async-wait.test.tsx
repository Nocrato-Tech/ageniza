// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

/** A screen that only shows its content after `delayMs` of real time, as one starved of CPU does (issue #746). */
function Slow({ delayMs }: { delayMs: number }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return ready ? <h1>Pronto</h1> : <p>Carregando</p>;
}

describe('the wait of the suite (issue #746)', () => {
  // The library default is 1 s: a first render on a loaded runner took about that long and failed the suite at random.
  it('lets findBy outlast a screen that takes 1.5 s, and returns as soon as the element is there', async () => {
    render(<Slow delayMs={1500} />);
    const started = Date.now();
    expect(await screen.findByRole('heading', { name: 'Pronto' })).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('lets waitFor outlast a condition that holds only after 1.5 s', async () => {
    render(<Slow delayMs={1500} />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pronto' })).not.toBeNull());
  });
});
