import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

import { Button } from './index.js';

export interface ModalProps {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, closeLabel, onClose, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pointerStartedOutside = useRef(false);

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

  return <dialog
    ref={dialogRef}
    className="ui-modal"
    aria-labelledby={titleId}
    aria-modal="true"
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onPointerDown={(event) => { pointerStartedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={(event) => {
      if (pointerStartedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose();
      pointerStartedOutside.current = false;
    }}
  >
    <div className="ui-modal__heading">
      <h2 id={titleId}>{title}</h2>
      <Button variant="ghost" onClick={onClose} aria-label={closeLabel}><span aria-hidden="true">×</span></Button>
    </div>
    {children}
  </dialog>;
}
