import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { Button, IconButton } from './button.js';
import { Skeleton } from './skeleton.js';

export type DialogSize = 'sm' | 'md' | 'lg';

/** Opt-in guard against losing what was typed: while dirty, Esc, a click outside and the X ask before they close. */
export interface DiscardGuard {
  /** Something was typed or changed. When false the dialog closes straight away. */
  dirty: boolean;
  title?: string;
  description?: string;
  /** The primary action: back to the form. */
  keepLabel?: string;
  /** The dangerous action: close and lose what was typed. */
  discardLabel?: string;
  /** Accessible name of the X of the confirmation. */
  closeLabel?: string;
}

export interface DialogProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** One sentence under the title that says what the dialog is for; it describes the dialog to assistive technology. */
  description?: string;
  /** The buttons at the foot, right-aligned; the one primary action goes last. */
  actions?: ReactNode;
  size?: DialogSize;
  /** Shows the reserved shape of the body instead of its content while it loads. */
  loading?: boolean;
  /** Confirms before closing a form with typed data. Closing after a success is the caller's own `onClose` call, which never asks. */
  confirmDiscard?: DiscardGuard;
  children?: ReactNode;
}

/** A modal dialog on the native `<dialog>`: focus trap, inert background and Esc come from the platform. */
export function Dialog({ title, closeLabel, onClose, description, actions, size = 'md', loading = false, confirmDiscard, children }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const pointerStartedOutside = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const guarded = confirmDiscard?.dirty === true;
  const requestClose = (): void => { if (guarded) setConfirming(true); else onClose(); };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previousFocus = document.activeElement;
    // The native modal makes the rest of the document inert, including the agency navigation.
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const outside = (clientX: number, clientY: number): boolean => {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return bounds !== undefined && (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom);
  };

  return <>
  <dialog
    ref={dialogRef}
    className={`ui-modal ui-modal--${size}`}
    aria-labelledby={titleId}
    aria-describedby={description === undefined ? undefined : descriptionId}
    aria-modal="true"
    aria-busy={loading || undefined}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); requestClose(); }}
    onPointerDown={(event) => { pointerStartedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={(event) => {
      if (pointerStartedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) requestClose();
      pointerStartedOutside.current = false;
    }}
  >
    <div className="ui-modal__heading">
      <h2 id={titleId}>{title}</h2>
      <IconButton label={closeLabel} icon={<X />} onClick={requestClose} />
    </div>
    {description !== undefined && <p id={descriptionId} className="ui-modal__description">{description}</p>}
    {loading ? <><Skeleton /><Skeleton /></> : children}
    {actions !== undefined && <div className="ui-modal__actions">{actions}</div>}
  </dialog>
  {guarded && confirming && <Dialog
    title={confirmDiscard.title ?? 'Descartar o que você escreveu?'}
    description={confirmDiscard.description ?? 'O que você digitou será perdido.'}
    closeLabel={confirmDiscard.closeLabel ?? 'Fechar confirmação'}
    size="sm"
    onClose={() => setConfirming(false)}
    actions={<>
      <Button variant="destructive" onClick={onClose}>{confirmDiscard.discardLabel ?? 'Descartar'}</Button>
      <Button onClick={() => setConfirming(false)}>{confirmDiscard.keepLabel ?? 'Continuar editando'}</Button>
    </>}
  />}
  </>;
}
