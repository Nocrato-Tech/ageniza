import { useState } from 'react';

/** The rule under a new-password field stays hidden until the person focuses the field or types in it. */
export function usePasswordHint(value: string): { hint: string | undefined; focusProps: { onFocus: () => void; onBlur: () => void } } {
  const [focused, setFocused] = useState(false);
  return {
    hint: focused || value !== '' ? 'Mínimo de 10 caracteres' : undefined,
    focusProps: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  };
}
