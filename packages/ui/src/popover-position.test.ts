import { describe, expect, it } from 'vitest';

import { placeFloating } from './popover-position.js';

const viewport = { width: 1000, height: 800 };
const card = { width: 300, height: 400 };
const place = (anchor: { top: number; left: number }, placement: Parameters<typeof placeFloating>[3]) =>
  placeFloating({ ...anchor, width: 100, height: 60 }, card, viewport, placement, 8, 8);

describe('placeFloating', () => {
  it('opens below and from the start edge of the anchor when there is room', () => {
    expect(place({ top: 100, left: 200 }, 'bottom-start')).toEqual({ top: 168, left: 200 });
  });

  it('opens above when the placement asks for it and there is room above', () => {
    expect(place({ top: 500, left: 200 }, 'top-start')).toEqual({ top: 92, left: 200 });
  });

  it('aligns the end of the card with the end of the anchor, so it grows to the left', () => {
    expect(place({ top: 100, left: 800 }, 'bottom-end')).toEqual({ top: 168, left: 600 });
  });

  it('flips below when it asked for above and the room above is too short, and flips above when below is the one without room', () => {
    expect(place({ top: 100, left: 200 }, 'top-start').top).toBe(168);
    expect(place({ top: 600, left: 200 }, 'bottom-start').top).toBe(192);
  });

  it('goes beside the anchor, never over it, when neither above nor below has room', () => {
    const middle = { top: 300, height: 60, width: 100 };
    const tall = { width: 300, height: 600 };
    const at = (left: number, placement: Parameters<typeof placeFloating>[3]) => placeFloating({ ...middle, left }, tall, viewport, placement, 8, 8);
    expect(at(200, 'bottom-start')).toEqual({ top: 192, left: 308 });
    expect(at(200, 'bottom-end')).toEqual({ top: 192, left: 308 });
    expect(at(400, 'bottom-start')).toEqual({ top: 192, left: 508 });
    expect(at(400, 'bottom-end')).toEqual({ top: 192, left: 92 });
    expect(at(600, 'bottom-start')).toEqual({ top: 192, left: 292 });
    expect(at(600, 'bottom-end')).toEqual({ top: 192, left: 292 });
    expect(at(700, 'bottom-start')).toEqual({ top: 192, left: 392 });
    expect(at(850, 'top-end')).toEqual({ top: 192, left: 542 });
    // The card has to clear the margin of the screen on its far side too, not only fit in it.
    expect(at(587, 'bottom-start')).toEqual({ top: 192, left: 279 });
  });

  it('with no room above, below or beside, keeps to the side the placement asked for, pulled inside the viewport', () => {
    const phone = { width: 400, height: 800 };
    const at = (placement: Parameters<typeof placeFloating>[3]) =>
      placeFloating({ top: 300, left: 50, width: 100, height: 60 }, { width: 350, height: 600 }, phone, placement, 8, 8);
    expect(at('top-start')).toEqual({ top: 8, left: 42 });
    expect(at('bottom-start')).toEqual({ top: 192, left: 42 });
  });

  it('keeps the card inside the viewport when neither side has room, and when the anchor is at an edge', () => {
    const tall = placeFloating({ top: 300, left: 0, width: 100, height: 60 }, { width: 300, height: 700 }, viewport, 'bottom-start', 8, 8);
    expect(tall.top).toBe(92);
    expect(tall.top + 700).toBe(800 - 8);
    expect(placeFloating({ top: 300, left: 0, width: 100, height: 60 }, { width: 300, height: 900 }, viewport, 'bottom-start', 8, 8).top).toBe(8);
    expect(place({ top: 100, left: 950 }, 'bottom-start').left).toBe(1000 - 300 - 8);
    expect(place({ top: 100, left: 0 }, 'bottom-end').left).toBe(8);
  });
});
