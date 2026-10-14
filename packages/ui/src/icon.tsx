import type { ReactNode } from 'react';

/** Wraps a lucide icon so every control sizes and strokes it the same way; the icon never names the control. */
export function IconSlot({ children }: { children: ReactNode }) {
  return <span className="ui-icon" aria-hidden="true">{children}</span>;
}
