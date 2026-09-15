import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'neutral' | 'danger';
};

/** A semantic button with a stable focus indicator supplied by the consumer stylesheet. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, tone = 'primary', type = 'button', ...props },
  ref
) {
  return <button ref={ref} type={type} className={['ui-button', `ui-button--${tone}`, className].filter(Boolean).join(' ')} {...props} />;
});

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

/** Native input passthrough that preserves labels, descriptions, and browser accessibility behaviour. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ className, ...props }, ref) {
  return <input ref={ref} className={['ui-text-input', className].filter(Boolean).join(' ')} {...props} />;
});

export function FieldMessage({ id, children, ...props }: HTMLAttributes<HTMLParagraphElement> & { children: ReactNode }) {
  return <p id={id} className="ui-field-message" {...props}>{children}</p>;
}

/** Announces asynchronous state changes without replacing the current page landmark. */
export function LiveStatus({ children, ...props }: HTMLAttributes<HTMLParagraphElement> & { children: ReactNode }) {
  return <p role="status" aria-live="polite" className="ui-live-status" {...props}>{children}</p>;
}
