import type { HTMLAttributes } from 'react';

export type TraitProps = HTMLAttributes<HTMLSpanElement>;

/** A short trait of a persona ("Rotina corrida") in a neutral capsule. It only describes: it is static, so it has no hover, focus or loading. */
export function Trait({ className, ...props }: TraitProps) {
  return <span className={['ui-trait', className].filter(Boolean).join(' ')} {...props} />;
}
