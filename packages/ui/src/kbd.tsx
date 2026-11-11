import type { HTMLAttributes } from 'react';

export type KbdProps = HTMLAttributes<HTMLElement>;

/** A key or a chord as the keyboard labels it ("Ctrl K"). It only names the shortcut; the control that owns the shortcut makes it work. */
export function Kbd({ className, ...props }: KbdProps) {
  return <kbd className={['ui-kbd', className].filter(Boolean).join(' ')} {...props} />;
}
