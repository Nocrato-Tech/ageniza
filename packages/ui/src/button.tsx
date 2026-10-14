import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { IconSlot } from './icon.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `secondary` is shadcn's `outline`; Ageniza never exposes `outline` itself (docs/design-system.md section 13). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Busy: the click does nothing but the button keeps keyboard focus, which a native `disabled` would drop. */
  loading?: boolean;
  /** A lucide icon before or after the label; decorative, so the label still names the button. */
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

/** A semantic button with a stable focus indicator supplied by the consumer stylesheet. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, type = 'button', disabled, leadingIcon, trailingIcon, children, onClick, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      className={[
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        loading && 'ui-button--loading',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {leadingIcon !== undefined && <IconSlot>{leadingIcon}</IconSlot>}
      {children !== undefined && <span className="ui-button__label">{children}</span>}
      {trailingIcon !== undefined && <IconSlot>{trailingIcon}</IconSlot>}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon'> & {
  /** Names the button for assistive technology and, as a tooltip, for everyone else. */
  label: string;
  icon: ReactNode;
};

/** A square button with only an icon: the label is mandatory because the glyph has no text. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', className, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      aria-label={label}
      title={label}
      leadingIcon={icon}
      className={['ui-icon-button', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
});
