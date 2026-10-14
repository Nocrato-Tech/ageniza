import { useLayoutEffect, type ReactNode } from 'react';

/** The addresses `DarkArea` covers, for what renders outside the router (the error boundary). */
export const isAgencyPath = (pathname: string): boolean => pathname.startsWith('/agencia/');

/**
 * The agency area is dark and everything else is light (docs/design-system.md section 7). The
 * attribute goes on `<html>`, not on a wrapper, so the page background, the scrollbars and what
 * renders in a portal (modals, menus) take the theme too. Leaving the area removes it.
 */
export function DarkArea({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, []);
  return <>{children}</>;
}
