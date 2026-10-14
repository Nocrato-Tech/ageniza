import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';

import type { ButtonSize, ButtonVariant } from './button.js';
import { IconSlot } from './icon.js';

type ButtonLinkOwnProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  /** A link cannot be `disabled`: it stays on the page as a dimmed `aria-disabled` link with no address and no action. */
  disabled?: boolean;
};

export type ButtonLinkProps<C extends ElementType = 'a'> = ButtonLinkOwnProps & {
  /** The element or component that navigates: `a` by default, the router's `Link` in the app (`as={Link} to="/clientes"`). */
  as?: C;
} & Omit<ComponentPropsWithoutRef<C>, keyof ButtonLinkOwnProps | 'as'>
  // An anchor without an address is not a link: the plain form needs `href` (a component given in `as` asks for its own, such as `to`).
  & (C extends 'a' ? { href: string } : unknown);

/**
 * Navigation that looks like a `Button`: same variants, sizes, icons and look, but a real link, so it opens in a new tab,
 * is announced as a link and goes where the address says. Use `Button` for something that acts, this for somewhere to go.
 */
export function ButtonLink<C extends ElementType = 'a'>({
  as, variant = 'primary', size = 'md', leadingIcon, trailingIcon, disabled = false, className, children, ...props
}: ButtonLinkProps<C>) {
  // A disabled link is not a link to anywhere: no `href` or `to` reaches the DOM, so it cannot be followed or tabbed to.
  const inert: Record<string, unknown> = { ...props };
  for (const address of ['href', 'to', 'onClick']) delete inert[address];
  const Component: ElementType = disabled ? 'span' : as ?? 'a';
  return (
    <Component
      className={['ui-button', `ui-button--${variant}`, `ui-button--${size}`, disabled && 'ui-button--link-disabled', className].filter(Boolean).join(' ')}
      {...(disabled ? { ...inert, role: 'link', 'aria-disabled': true } : props)}
    >
      {leadingIcon !== undefined && <IconSlot>{leadingIcon}</IconSlot>}
      <span className="ui-button__label">{children}</span>
      {trailingIcon !== undefined && <IconSlot>{trailingIcon}</IconSlot>}
    </Component>
  );
}
