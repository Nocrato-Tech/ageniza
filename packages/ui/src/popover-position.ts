import type { PopoverPlacement } from './popover.js';

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Placed {
  readonly top: number;
  readonly left: number;
}

/**
 * Where a floating card sits on the screen: on the side its placement asks for, flipped to the other side when
 * that one is the only one with room, and always pulled back inside the viewport, so a card at an edge of the page
 * opens inwards and nothing clips it. When neither above nor below has room it goes beside the anchor, on the side
 * with room, instead of sliding over it.
 */
export function placeFloating(anchor: Box, card: Size, viewport: Size, placement: PopoverPlacement, gap: number, margin: number): Placed {
  const wantsTop = placement.startsWith('top');
  const room = {
    above: anchor.top - gap - margin,
    below: viewport.height - (anchor.top + anchor.height) - gap - margin
  };
  const clamp = (value: number, size: number, limit: number): number => Math.max(margin, Math.min(value, limit - size - margin));
  if (room.above < card.height && room.below < card.height) {
    const rightOf = anchor.left + anchor.width + gap;
    const leftOf = anchor.left - gap - card.width;
    const prefersLeft = placement.endsWith('end');
    const fitsRight = rightOf + card.width + margin <= viewport.width;
    const fitsLeft = leftOf >= margin;
    if (fitsRight || fitsLeft) {
      const left = fitsLeft && (prefersLeft || !fitsRight) ? leftOf : rightOf;
      return { top: clamp(anchor.top, card.height, viewport.height), left };
    }
  }
  const above = wantsTop ? room.above >= card.height || room.below < card.height : room.below < card.height && room.above >= card.height;
  const rawTop = above ? anchor.top - gap - card.height : anchor.top + anchor.height + gap;
  const rawLeft = placement.endsWith('end') ? anchor.left + anchor.width - card.width : anchor.left;
  return { top: clamp(rawTop, card.height, viewport.height), left: clamp(rawLeft, card.width, viewport.width) };
}
