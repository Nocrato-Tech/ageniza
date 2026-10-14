import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
export { Avatar, avatarInitials, type AvatarProps, type AvatarSize } from './avatar.js';
export { BadgeCard, type BadgeCardProps } from './badge-card.js';
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from './button.js';
export { Logo, BrandSymbol, type LogoProps, type LogoVariant, type BrandSymbolProps, type BrandSymbolVariant } from './brand.js';
export { ConfirmDialog, Menu, MenuItem, MenuSeparator } from './menu.js';
export { Dialog, Dialog as Modal, type DialogProps, type DialogProps as ModalProps, type DialogSize } from './dialog.js';
export { Field, type FieldControlProps, type FieldProps } from './field.js';
export { Pagination, paginationItems, type PaginationProps } from './pagination.js';
export { Pill, PillAction, type PillActionProps, type PillProps, type PillTone } from './pill.js';
export { Segmented, type SegmentedOption, type SegmentedProps } from './segmented.js';
export { Select, type SelectOption, type SelectProps } from './select.js';
export { Skeleton } from './skeleton.js';
export { Tabs, type TabItem, type TabsProps } from './tabs.js';
export { Textarea, type TextareaProps } from './textarea.js';

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

export type ChoiceCardProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  /** Primary line, the item's own name. */
  title: string;
  /** Secondary line that distinguishes items sharing a name (kind, role, owner). */
  description: string;
  /** Visual emphasis for the server's probable option; it never selects or submits on its own. */
  highlighted?: boolean;
  /** Short visible label (e.g. "Sugerido"); part of the card's accessible name. */
  badge?: string;
};

/** A full-width, whole-surface clickable card used by single-choice pickers. */
export const ChoiceCard = forwardRef<HTMLButtonElement, ChoiceCardProps>(function ChoiceCard(
  { className, title, description, highlighted = false, badge, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['ui-choice-card', highlighted && 'ui-choice-card--highlighted', className].filter(Boolean).join(' ')}
      {...props}
    >
      {badge !== undefined && <span className="ui-choice-card__badge">{badge}</span>}
      <span className="ui-choice-card__title">{title}</span>
      <span className="ui-choice-card__description">{description}</span>
    </button>
  );
});
