import { useLayoutEffect, type ReactNode } from 'react';

/** The addresses `DarkArea` covers, for what renders outside the router (the error boundary). */
export const isAgencyPath = (pathname: string): boolean => /^\/agencia\/[^/]/.test(pathname);

/**
 * The agency area is dark and everything else is light (docs/design-system.md section 7). The
 * attribute goes on `<html>`, not on a wrapper, so the page background, the scrollbars and what
 * renders in a portal (modals, menus) take the theme too. Leaving the area removes it.
 */
export function DarkArea({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    // The theme the page shipped with (index.html) is not a previous theme to give back.
    const previous = root.hasAttribute('data-theme-early') ? null : root.getAttribute('data-theme');
    root.removeAttribute('data-theme-early');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, []);
  return <>{children}</>;
}
