// @vitest-environment jsdom
import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { base, click, makeFetch, openContent, render_, setupModalTests, stored, type } from './content-modal-fixture.js';
setupModalTests();
it('protects an edited content on close and preserves work when the person continues editing', async () => {
  await openContent(stored({ title: 'Título salvo' }));
  type('Título', 'Alteração não salva');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Descartar alterações?' });
  expect(confirmation.textContent).toContain('As alterações não salvas serão perdidas.');
  fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Alteração não salva');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descartar alterações' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('keeps discard confirmation visible when closing from assignment after editing general', async () => {
  await openContent(stored({ title: 'Título salvo' }));
  type('Título', 'Alteração não salva');
  fireEvent.click(screen.getByRole('tab', { name: 'Atribuição' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  expect(await screen.findByRole('dialog', { name: 'Descartar alterações?' })).toBeTruthy();
});

const contentDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Título salvo' });
const pressOutside = (): void => {
  const target = contentDialog();
  const down = createEvent.pointerDown(target, { bubbles: true });
  Object.defineProperty(down, 'clientX', { value: 5 });
  Object.defineProperty(down, 'clientY', { value: 5 });
  fireEvent(target, down);
  fireEvent.click(target, { clientX: 5, clientY: 5 });
};

const WAYS: ReadonlyArray<readonly [string, () => void]> = [
  ['Esc', () => { fireEvent(contentDialog(), new Event('cancel', { bubbles: true, cancelable: true })); }],
  ['a click outside', pressOutside],
  ['the X', () => { fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' })); }],
  ['the Fechar of the form', () => { click('Fechar'); }]
];

describe.each(WAYS)('closing with %s (decision 2026-11-10)', (_name, close) => {
  it('asks first when something was typed, and the content stays open with what was typed until the person decides', async () => {
    await openContent(stored({ title: 'Título salvo' }));
    type('Título', 'Alteração não salva');

    close();

    const confirmation = await screen.findByRole('dialog', { name: 'Descartar alterações?' });
    expect(confirmation.textContent).toContain('As alterações não salvas serão perdidas. Continue editando para salvá-las.');
    expect(screen.getByRole('button', { name: 'Continuar editando' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Descartar alterações' })).toBeTruthy();
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Alteração não salva');
  });

  it('closes straight away when nothing was typed', async () => {
    const { probe } = await openContent(stored({ title: 'Título salvo' }));

    close();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Descartar alterações?' })).toBeNull();
    expect(probe.pathname).toBe(base());
  });

  it('closes straight away when what was typed was typed back to what is saved', async () => {
    await openContent(stored({ title: 'Título salvo' }));
    type('Título', 'Outro');
    type('Título', 'Título salvo');

    close();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the confirmation of a discard', () => {
  it('leaves the modal when the person discards, and closes only the confirmation when the person keeps editing', async () => {
    const { probe } = await openContent(stored({ title: 'Título salvo' }));
    type('Título', 'Alteração não salva');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Continuar editando' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Descartar alterações?' })).toBeNull());
    expect(contentDialog()).toBeTruthy();
    expect(probe.pathname).not.toBe(base());

    fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar alterações' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(probe.pathname).toBe(base());
  });

  it('is not asked after a save: the modal closes by itself and the typed text is gone with it', async () => {
    const { probe, calls } = await openContent(stored({ title: 'Título salvo' }));
    type('Título', 'Título novo');

    click('Salvar');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'PATCH')).toBe(true);
    expect(probe.pathname).toBe(base());
  });

  it('does not close while the save is on its way, with no question either', async () => {
    let answer: (() => void) | undefined;
    const { calls } = await openContent(stored({ title: 'Título salvo' }), {
      override: (call) => (call.method === 'PATCH'
        ? new Promise<Response>((resolve) => { answer = () => { resolve(new Response(null, { status: 500 })); }; })
        : undefined)
    });
    type('Título', 'Título novo');
    click('Salvar');
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));

    fireEvent(contentDialog(), new Event('cancel', { bubbles: true, cancelable: true }));

    expect(screen.queryByRole('dialog', { name: 'Descartar alterações?' })).toBeNull();
    expect(contentDialog()).toBeTruthy();
    answer?.();
  });

  it('asks about a new content with something typed, and closes the empty one at once', async () => {
    const { impl } = makeFetch({});
    const typed = render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Rascunho');
    fireEvent(screen.getByRole('dialog', { name: 'Novo conteúdo' }), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(await screen.findByRole('dialog', { name: 'Descartar alterações?' })).toBeTruthy();
    typed.unmount();

    const empty = render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    fireEvent(screen.getByRole('dialog', { name: 'Novo conteúdo' }), new Event('cancel', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(empty.probe.pathname).toBe(base());
  });
});
