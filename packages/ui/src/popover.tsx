import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode, type Ref } from 'react';

import { placeFloating, type Placed } from './popover-position.js';
import { Skeleton } from './skeleton.js';

const FLOATING_GAP = 8;
const FLOATING_MARGIN = 8;

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

/** What the trigger must spread on itself; it has to be a button, so Enter and Space work and focus can return to it. */
export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  'aria-haspopup': 'dialog';
  'aria-disabled': true | undefined;
  /** Present only when the popover opens on click; a hover card leaves the press to the trigger's own action. */
  onClick: (() => void) | undefined;
}

export interface PopoverProps {
  /** Names the floating card for assistive technology. */
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode;
  /** `hover` opens after the pointer rests on it, or at once on keyboard focus, and never on touch. */
  openOn?: 'click' | 'hover';
  /** How long a mouse has to rest before a hover card opens, in ms. */
  hoverDelay?: number;
  /** How long a hover card waits after the mouse leaves before it closes, in ms: the time to cross the gap onto the card (WCAG 1.4.13). */
  hoverLeaveDelay?: number;
  /** Where the card sits; it does not flip at the edge of the screen, so pick the side with room. */
  placement?: PopoverPlacement;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Shows the reserved shape of the card instead of its content while it loads. */
  loading?: boolean;
  /**
   * `fixed` places the card on the screen, not inside the anchor: it opens towards the side the placement asks for,
   * flips and slides to stay inside the viewport, and closes when the page scrolls. Use it where a scrolling or
   * clipping ancestor would cut an absolute card.
   */
  strategy?: 'absolute' | 'fixed';
  className?: string;
}

const keyboardFocus = (target: EventTarget): boolean => {
  try {
    return !(target instanceof Element) || target.matches(':focus-visible');
  } catch {
    return true;
  }
};

// Until it is measured the card is laid out out of sight, so its size can be read without a flash at the wrong place.
const fixedStyle = (placed: Placed | null): CSSProperties => (placed === null ? { visibility: 'hidden', top: 0, left: 0 } : { top: placed.top, left: placed.left });

/** A floating card anchored to its trigger: Esc and a press outside close it and give focus back to the trigger. */
export function Popover({ label, trigger, children, openOn = 'click', hoverDelay = 300, hoverLeaveDelay = 150, placement = 'bottom-start', onOpenChange, disabled = false, loading = false, strategy = 'absolute', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelId = useId();

  const change = (next: boolean): void => {
    if (next === open) return;
    setOpen(next);
    onOpenChange?.(next);
  };

  const clearTimer = (): void => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };

  useEffect(() => clearTimer, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) change(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      change(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  useLayoutEffect(() => {
    if (!open || strategy !== 'fixed') {
      setPlaced(null);
      return;
    }
    const place = (): void => {
      const anchor = wrapperRef.current?.getBoundingClientRect();
      const card = panelRef.current?.getBoundingClientRect();
      if (anchor === undefined || card === undefined) return;
      setPlaced(placeFloating(anchor, card, { width: window.innerWidth, height: window.innerHeight }, placement, FLOATING_GAP, FLOATING_MARGIN));
    };
    place();
    // The content arrives after the card opens (a request): the card grows, and it has to be placed again.
    if (typeof ResizeObserver === 'undefined' || panelRef.current === null) return;
    const observer = new ResizeObserver(place);
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [open, strategy, placement]);

  useEffect(() => {
    if (!open || strategy !== 'fixed') return;
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      change(false);
    };
    const onResize = (): void => change(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  });

  useEffect(() => {
    if (disabled) {
      clearTimer();
      change(false);
    }
  }, [disabled]);

  const onPointerEnter = (event: PointerEvent): void => {
    if (openOn !== 'hover' || disabled || event.pointerType !== 'mouse') return;
    // Back from the gap onto the card (or the trigger): this drops the close that was waiting, and the card stays.
    clearTimer();
    timerRef.current = setTimeout(() => change(true), hoverDelay);
  };

  const onPointerLeave = (event: PointerEvent): void => {
    if (openOn !== 'hover' || event.pointerType !== 'mouse') return;
    clearTimer();
    // The card sits a gap away from the trigger, so the mouse leaves both on its way across: wait before closing.
    if (open) timerRef.current = setTimeout(() => change(false), hoverLeaveDelay);
  };

  const onFocus = (event: FocusEvent): void => {
    if (openOn !== 'hover' || disabled || !keyboardFocus(event.target)) return;
    clearTimer();
    change(true);
  };

  const onBlur = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && wrapperRef.current?.contains(event.relatedTarget)) return;
    clearTimer();
    change(false);
  };

  return (
    <span
      ref={wrapperRef}
      className={['ui-popover-anchor', className].filter(Boolean).join(' ')}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {trigger({
        ref: triggerRef,
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        'aria-haspopup': 'dialog',
        'aria-disabled': disabled ? true : undefined,
        onClick: openOn === 'click' && !disabled ? () => change(!open) : undefined
      })}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={label}
          aria-busy={loading || undefined}
          data-placement={placement}
          className={strategy === 'fixed' ? 'ui-popover ui-popover--fixed' : `ui-popover ui-popover--${placement}`}
          style={strategy === 'fixed' ? fixedStyle(placed) : undefined}
        >
          {loading ? <><Skeleton /><Skeleton /></> : children}
        </div>
      )}
    </span>
  );
}
