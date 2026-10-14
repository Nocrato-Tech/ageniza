import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode, type Ref } from 'react';

import { Skeleton } from './skeleton.js';

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
  /** Where the card sits; it does not flip at the edge of the screen, so pick the side with room. */
  placement?: PopoverPlacement;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** Shows the reserved shape of the card instead of its content while it loads. */
  loading?: boolean;
  className?: string;
}

const keyboardFocus = (target: EventTarget): boolean => {
  try {
    return !(target instanceof Element) || target.matches(':focus-visible');
  } catch {
    return true;
  }
};

/** A floating card anchored to its trigger: Esc and a press outside close it and give focus back to the trigger. */
export function Popover({ label, trigger, children, openOn = 'click', hoverDelay = 300, placement = 'bottom-start', onOpenChange, disabled = false, loading = false, className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (disabled) {
      clearTimer();
      change(false);
    }
  }, [disabled]);

  const onPointerEnter = (event: PointerEvent): void => {
    if (openOn !== 'hover' || disabled || event.pointerType !== 'mouse') return;
    clearTimer();
    timerRef.current = setTimeout(() => change(true), hoverDelay);
  };

  const onPointerLeave = (event: PointerEvent): void => {
    if (openOn !== 'hover' || event.pointerType !== 'mouse') return;
    clearTimer();
    change(false);
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
        <div id={panelId} role="dialog" tabIndex={-1} aria-label={label} aria-busy={loading || undefined} className={`ui-popover ui-popover--${placement}`}>
          {loading ? <><Skeleton /><Skeleton /></> : children}
        </div>
      )}
    </span>
  );
}
