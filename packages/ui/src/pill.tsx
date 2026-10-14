import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

import { IconSlot } from './icon.js';

/** `accent` is the filled indigo: reserved for the action, today, what is the viewer's turn and the selected client (docs/design-system.md). */
export type PillTone = 'neutral' | 'accent';

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: PillTone;
  icon?: ReactNode;
};

/** A counter or short label in a full-radius capsule. It is static: for something to press, use `PillAction`. */
export function Pill({ tone = 'neutral', icon, className, children, ...props }: PillProps) {
  return (
    <span className={['ui-pill', `ui-pill--${tone}`, className].filter(Boolean).join(' ')} {...props}>
      {icon !== undefined && <IconSlot>{icon}</IconSlot>}
      {children}
    </span>
  );
}

export type PillActionProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: PillTone;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

/** The next action of a card in a capsule, e.g. "Abrir"; a real button with the same states as `Button`. */
export const PillAction = forwardRef<HTMLButtonElement, PillActionProps>(function PillAction(
  { tone = 'neutral', loading = false, type = 'button', disabled, leadingIcon, trailingIcon, className, children, onClick, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      className={['ui-pill', 'ui-pill--action', `ui-pill--${tone}`, loading && 'ui-pill--loading', className].filter(Boolean).join(' ')}
      {...props}
    >
      {leadingIcon !== undefined && <IconSlot>{leadingIcon}</IconSlot>}
      <span className="ui-pill__label">{children}</span>
      {trailingIcon !== undefined && <IconSlot>{trailingIcon}</IconSlot>}
    </button>
  );
});
