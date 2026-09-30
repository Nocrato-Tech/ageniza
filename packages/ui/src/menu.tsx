import * as React from 'react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

import { Button } from './index.js';

interface MenuContextValue {
  close: () => void;
}

const MenuContext = React.createContext<MenuContextValue | null>(null);

export interface MenuProps {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}

const menuItems = (menu: HTMLElement): HTMLElement[] =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled]):not([aria-disabled=true])'));

export function Menu({ label, trigger, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current === null ? undefined : menuItems(menuRef.current)[0];
    first?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.parentElement?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || menuRef.current === null) return;
    const items = menuItems(menuRef.current);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className='ui-menu'>
      <button
        ref={triggerRef}
        type='button'
        className='ui-menu__trigger'
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open && (
        <MenuContext.Provider value={{ close }}>
          <div ref={menuRef} id={menuId} role='menu' aria-label={label} className='ui-menu__content' onKeyDown={onMenuKeyDown}>
            {children}
          </div>
        </MenuContext.Provider>
      )}
    </div>
  );
}

export type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: 'default' | 'destructive';
};

export const MenuItem = React.forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { className, variant = 'default', onClick, disabled, children, ...props },
  ref
) {
  const menu = React.useContext(MenuContext);
  return (
    <button
      {...props}
      ref={ref}
      type='button'
      role='menuitem'
      disabled={disabled}
      className={['ui-menu-item', 'ui-menu-item--' + variant, className].filter(Boolean).join(' ')}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) menu?.close();
      }}
    >
      {children}
    </button>
  );
});

export function MenuSeparator() {
  return <div role='separator' className='ui-menu-separator' />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className='ui-dialog-backdrop'>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className='ui-dialog'
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className='ui-dialog__actions'>
          <Button ref={cancelRef} variant='secondary' onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant='destructive' onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
