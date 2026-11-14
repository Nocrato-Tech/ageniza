import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { IconSlot } from './icon.js';

/** `danger-quiet` is the discreet danger: red text on no fill, for a destructive action that must not compete with the one primary (the filled `destructive` stays for the confirmation). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'danger-quiet';
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
  /**
   * Why the action is unavailable right now (a plan to renew): the button stays visible and focusable, answers nothing,
   * and shows the reason on hover and on keyboard focus, as its description.
   */
  blockedReason?: string | undefined;
};

/** A semantic button with a stable focus indicator supplied by the consumer stylesheet. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, type = 'button', disabled, leadingIcon, trailingIcon, blockedReason, children, onClick, 'aria-describedby': describedBy, ...props },
  ref
) {
  const tipId = useId();
  const blocked = blockedReason !== undefined;
  const description = blocked ? [describedBy, tipId].filter(Boolean).join(' ') : describedBy;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || blocked || undefined}
      aria-describedby={description}
      onClick={loading || blocked ? (event) => event.preventDefault() : onClick}
      className={[
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        loading && 'ui-button--loading',
        blocked && 'ui-button--blocked',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {leadingIcon !== undefined && <IconSlot>{leadingIcon}</IconSlot>}
      {children !== undefined && <span className="ui-button__label">{children}</span>}
      {trailingIcon !== undefined && <IconSlot>{trailingIcon}</IconSlot>}
      {/* Hidden from the name, read as the description; CSS shows it on hover and focus. */}
      {blocked && <span id={tipId} aria-hidden="true" className="ui-button__tip">{blockedReason}</span>}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon'> & {
  /** Names the button for assistive technology and, as a tooltip, for everyone else. */
  label: string;
  icon: ReactNode;
  /** A notification dot on the corner. The text says what it means ("3 não lidas") and joins the name, so the dot is never only colour. */
  dot?: string;
};

/** A square button with only an icon: the label is mandatory because the glyph has no text. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, dot, variant = 'ghost', className, ...props },
  ref
) {
  const name = dot === undefined ? label : `${label}, ${dot}`;
  return (
    <Button
      ref={ref}
      variant={variant}
      aria-label={name}
      title={name}
      leadingIcon={dot === undefined ? icon : <>{icon}<span className="ui-icon-button__dot" aria-hidden="true" /></>}
      className={['ui-icon-button', dot !== undefined && 'ui-icon-button--dot', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
});
