import { useSyncExternalStore } from 'react';

const WIDE = '(min-width: 48rem)';

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(WIDE);
  query.addEventListener?.('change', notify);
  return () => { query.removeEventListener?.('change', notify); };
};

/** The shells change their markup below 48rem, not just their layout: the top bar and the bottom bar are other controls. */
export const usePhone = (): boolean => useSyncExternalStore(
  subscribe,
  () => typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches,
  () => false
);
