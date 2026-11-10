// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, Dialog, Modal } from './index.js';

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);

// jsdom has no native modal: the stub opens and closes the element and leaves the rest to the component.
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; this.querySelector('button')?.focus(); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)[name];
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

// jsdom builds pointer events without coordinates, so the tests give them the way a browser reports them.
const press = (element: HTMLElement, x: number, y: number): void => {
  const event = createEvent.pointerDown(element, { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  fireEvent(element, event);
};

const dialog = (): HTMLDialogElement => screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;

describe('Dialog', () => {
  it('is a modal dialog named by its title, open as soon as it mounts', () => {
    render(<Dialog title="Editar cliente" closeLabel="Fechar" onClose={() => undefined}><p>Corpo</p></Dialog>);

    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog());
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Editar cliente', level: 2 })).toBeTruthy();
    expect(screen.getByText('Corpo')).toBeTruthy();
  });

  it('closes by its close button, which is named by closeLabel and has no visible text', () => {
    const onClose = vi.fn();
    render(<Dialog title="Editar cliente" closeLabel="Fechar edição" onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Fechar edição' });

    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(close.textContent).toBe('');
    expect(close.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('turns Esc into onClose and keeps itself mounted until its owner decides', () => {
    const onClose = vi.fn();
    render(<Dialog title="Editar cliente" closeLabel="Fechar" onClose={onClose} />);

    const notPrevented = fireEvent(dialog(), new Event('cancel', { bubbles: true, cancelable: true }));

    expect(notPrevented).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBeTruthy();
  });

  it('does not let Esc reach a dialog underneath', () => {
    const outer = vi.fn();
    render(
      <div onCancel={outer}>
        <Dialog title="Editar cliente" closeLabel="Fechar" onClose={() => undefined} />
      </div>
    );

    fireEvent(dialog(), new Event('cancel', { bubbles: true, cancelable: true }));

    expect(outer).not.toHaveBeenCalled();
  });

  it('closes on a gesture that starts and ends outside, and only then', () => {
    const onClose = vi.fn();
    render(<Dialog title="Editar cliente" closeLabel="Fechar" onClose={onClose}><p>Corpo</p></Dialog>);

    press(screen.getByText('Corpo'), 5, 5);
    fireEvent.click(dialog(), { clientX: 5, clientY: 5 });
    expect(onClose).not.toHaveBeenCalled();

    press(dialog(), 5, 5);
    fireEvent.click(screen.getByText('Corpo'), { clientX: 5, clientY: 5 });
    expect(onClose).not.toHaveBeenCalled();

    press(dialog(), 5, 5);
    fireEvent.click(dialog(), { clientX: 5, clientY: 5 });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog(), { clientX: 5, clientY: 5 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives the focus back to what had it when it opened, once it unmounts', () => {
    render(<Button>Abrir</Button>);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    const { unmount } = render(<Dialog title="Editar cliente" closeLabel="Fechar" onClose={() => undefined} />);

    unmount();

    expect(document.activeElement).toBe(opener);
  });

  it('describes itself by the sentence under the title, and by nothing when it has none', () => {
    const { rerender } = render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} description="O cliente deixa a carteira." />);
    const describedBy = dialog().getAttribute('aria-describedby');

    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe('O cliente deixa a carteira.');

    rerender(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} />);
    expect(dialog().hasAttribute('aria-describedby')).toBe(false);
  });

  it('puts the actions at the foot, after the body', () => {
    render(
      <Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} actions={<><Button variant="secondary">Cancelar</Button><Button>Arquivar</Button></>}>
        <p>Corpo</p>
      </Dialog>
    );
    const children = [...dialog().children];
    const foot = dialog().querySelector('.ui-modal__actions')!;

    expect(foot.querySelectorAll('button')).toHaveLength(2);
    expect(children.indexOf(foot)).toBe(children.length - 1);
    expect(children.indexOf(foot)).toBeGreaterThan(children.findIndex((child) => child.textContent === 'Corpo'));
  });

  it('draws no foot without actions', () => {
    render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} />);

    expect(dialog().querySelector('.ui-modal__actions')).toBeNull();
  });

  it.each([['sm', 'ui-modal--sm'], ['md', 'ui-modal--md'], ['lg', 'ui-modal--lg']] as const)('takes the %s size', (size, className) => {
    render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} size={size} />);

    expect(dialog().className.split(' ')).toEqual(expect.arrayContaining(['ui-modal', className]));
  });

  it('is medium by default', () => {
    render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} />);

    expect(dialog().classList.contains('ui-modal--md')).toBe(true);
  });

  it('reserves the shape of the body and marks itself busy while loading', () => {
    render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined} loading><p>Corpo</p></Dialog>);

    expect(dialog().getAttribute('aria-busy')).toBe('true');
    expect(dialog().querySelectorAll('.ui-skeleton')).toHaveLength(2);
    expect(screen.queryByText('Corpo')).toBeNull();
  });

  it('shows its body and is not busy once loaded', () => {
    render(<Dialog title="Arquivar" closeLabel="Fechar" onClose={() => undefined}><p>Corpo</p></Dialog>);

    expect(dialog().hasAttribute('aria-busy')).toBe(false);
    expect(dialog().querySelector('.ui-skeleton')).toBeNull();
    expect(screen.getByText('Corpo')).toBeTruthy();
  });

  it('is still exported as Modal, for the screens that have not moved yet', () => {
    expect(Modal).toBe(Dialog);
  });
});

describe('Dialog with a discard guard', () => {
  const form = (dirty: boolean, onClose: () => void) => render(
    <Dialog title="Editar cliente" closeLabel="Fechar edição" onClose={onClose} confirmDiscard={{ dirty }}><p>Corpo</p></Dialog>
  );
  const form_dialog = (): HTMLDialogElement => screen.getByRole('dialog', { name: 'Editar cliente', hidden: true }) as HTMLDialogElement;
  const closers: ReadonlyArray<readonly [string, () => void]> = [
    ['Esc', () => { fireEvent(form_dialog(), new Event('cancel', { bubbles: true, cancelable: true })); }],
    ['a click outside', () => { press(form_dialog(), 5, 5); fireEvent.click(form_dialog(), { clientX: 5, clientY: 5 }); }],
    ['the X', () => { fireEvent.click(screen.getByRole('button', { name: 'Fechar edição' })); }]
  ];

  it.each(closers)('closes straight away on %s when nothing was typed', (_name, close) => {
    const onClose = vi.fn();
    form(false, onClose);

    close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Descartar o que você escreveu?', hidden: true })).toBeNull();
  });

  it.each(closers)('asks before closing on %s when there is typed data, and keeps the form', (_name, close) => {
    const onClose = vi.fn();
    form(true, onClose);

    close();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Descartar o que você escreveu?', hidden: true })).toBeTruthy();
    expect(screen.getByText('Corpo')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
    expect(screen.queryByRole('dialog', { name: 'Descartar o que você escreveu?', hidden: true })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(form_dialog().open).toBe(true);

    close();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the confirmation on Esc, and puts the dangerous action before the primary one', () => {
    const onClose = vi.fn();
    form(true, onClose);
    fireEvent(form_dialog(), new Event('cancel', { bubbles: true, cancelable: true }));
    const confirmation = screen.getByRole('dialog', { name: 'Descartar o que você escreveu?', hidden: true });

    const buttons = [...confirmation.querySelectorAll('.ui-modal__actions button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Descartar', 'Continuar editando']);
    expect(buttons[0]!.classList.contains('ui-button--destructive')).toBe(true);

    fireEvent(confirmation, new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Descartar o que você escreveu?', hidden: true })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes the wording from the caller', () => {
    render(<Dialog title="Convidar" closeLabel="Fechar" onClose={() => undefined} confirmDiscard={{ dirty: true, title: 'Perder o convite?', keepLabel: 'Voltar', discardLabel: 'Perder' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));

    expect(screen.getByRole('dialog', { name: 'Perder o convite?', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Perder' })).toBeTruthy();
  });
});