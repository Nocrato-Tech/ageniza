// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useCommittedLocation } from './location-probe-fixture.js';

// #405. The probe is read by waitFor(probe.pathname) before the screen is asserted: it must never
// say "B" while the screen still shows "A". A sibling that takes 40 ms to render after the probe
// makes the sliced transition yield between the two, which is what failed the CI in #382.
interface Probe { pathname: string; navigate: NavigateFunction }

function CommittedProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.navigate = navigate;
  });
  return null;
}

function RenderTimeProbe({ probe }: { probe: Probe }) {
  probe.pathname = useLocation().pathname;
  probe.navigate = useNavigate();
  return null;
}

const busyFor = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* a sibling that takes its time to render */ }
};

function SlowScreen() {
  const onB = useLocation().pathname === '/b';
  if (onB) busyFor(40);
  return <p data-testid="screen">{onB ? 'Tela B' : 'Tela A'}</p>;
}

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
beforeEach(() => {
  // The navigation below is not wrapped in act on purpose: act would flush the sliced render in one go.
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const navigateWatching = async (ProbeComponent: typeof CommittedProbe): Promise<Array<{ probe: string; screen: string }>> => {
  const probe: Probe = { pathname: '', navigate: () => undefined };
  const view = render(
    <MemoryRouter initialEntries={['/a']}>
      <ProbeComponent probe={probe} />
      <SlowScreen />
    </MemoryRouter>
  );
  const screenText = (): string => view.getByTestId('screen').textContent ?? '';
  const pause = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
  await pause();
  expect(probe.pathname).toBe('/a');

  probe.navigate('/b');
  const observed: Array<{ probe: string; screen: string }> = [];
  for (let step = 0; step < 100 && screenText() !== 'Tela B'; step += 1) {
    observed.push({ probe: probe.pathname, screen: screenText() });
    await pause();
  }
  expect(screenText()).toBe('Tela B');
  observed.push({ probe: probe.pathname, screen: screenText() });
  return observed;
};

describe('the location probe of the web tests', () => {
  it('never reports an address before the screen shows it, even with a slow sibling rendering after it', async () => {
    const observed = await navigateWatching(CommittedProbe);

    expect(observed.filter((seen) => seen.probe === '/b' && seen.screen === 'Tela A')).toEqual([]);
    expect(observed.at(-1)).toEqual({ probe: '/b', screen: 'Tela B' });
  });

  it('is needed: a probe that writes while rendering reports the new address with the old screen', async () => {
    const observed = await navigateWatching(RenderTimeProbe);

    expect(observed.some((seen) => seen.probe === '/b' && seen.screen === 'Tela A')).toBe(true);
  });
});
