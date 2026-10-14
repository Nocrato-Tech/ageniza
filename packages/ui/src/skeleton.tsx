import type { HTMLAttributes } from 'react';

/** Reserves the shape of content during its first load; decorative, never announced. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={['ui-skeleton', className].filter(Boolean).join(' ')} {...props} />;
}
