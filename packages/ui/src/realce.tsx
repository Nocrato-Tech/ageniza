import type { HTMLAttributes } from 'react';

export type RealceProps = HTMLAttributes<HTMLSpanElement> & {
  /** Sweeps in from the left when the word becomes the viewer's turn or something is approved; still, it just sits there. */
  sweep?: boolean;
};

/**
 * The block of indigo behind the one word that asks for a decision now, like a highlighter (it was "Marca" until the logo
 * took that name). Full indigo belongs to the action, today and the viewer's turn, so use it for nothing else.
 */
export function Realce({ sweep = false, className, children, ...props }: RealceProps) {
  return (
    <span className={['ui-realce', sweep && 'ui-realce--sweep', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </span>
  );
}
