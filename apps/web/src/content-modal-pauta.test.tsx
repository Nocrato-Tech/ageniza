// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  base,
  dialog,
  EDITOR,
  makeFetch,
  openContent,
  render_,
  setupModalTests,
  stored,
  type,
  type Format,
  type Status
} from './content-modal-fixture.js';

setupModalTests();

/** Every move of a content, so the footer shows whatever its state allows. */
const EVERYTHING = [...EDITOR, 'conteudo.aprovar_pela_agencia', 'conteudo.publicar', 'conteudo.cancelar'];

const footer = (): HTMLElement => dialog().querySelector<HTMLElement>('footer.content-modal__footer')!;
const primaries = (): string[] => [...footer().querySelectorAll<HTMLButtonElement>('button.ui-button--primary')].map((button) => button.textContent ?? '');

describe('the tags under the title', () => {
  // Written by hand, value by value: the table is not derived from the maps it checks.
  it.each([
    ['in_production', 'Em produção', 'production'],
    ['awaiting_approval', 'Aguardando aprovação', 'waiting'],
    ['adjusting', 'Em ajuste', 'adjust'],
    ['approved', 'Pronto para publicar', 'ready'],
    ['published', 'Publicado', 'published'],
    ['cancelled', 'Cancelado', 'production']
  ] as const)('a %s content wears the outlined tag "%s" with the %s icon', async (status, label, tone) => {
    await openContent(stored({ status }));
    const tag = dialog().querySelector('.content-modal__tags .ui-status-tag')!;

    expect(tag.textContent).toBe(label);
    expect(tag.classList.contains(`ui-status-tag--${tone}`)).toBe(true);
    expect(tag.querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['image', 'Imagem', 'static'],
    ['carousel', 'Carrossel', 'carousel'],
    ['reels', 'Reels', 'reels'],
    ['long_video', 'Vídeo longo', 'static'],
    ['vsl', 'VSL', 'static']
  ] as const satisfies ReadonlyArray<readonly [Format, string, string]>)('a %s content wears the %s tag in the %s tone', async (format, label, tone) => {
    await openContent(stored({ format }));
    const tag = dialog().querySelector('.content-modal__tags .ui-format-tag')!;

    expect(tag.textContent).toBe(label);
    expect(tag.classList.contains(`ui-format-tag--${tone}`)).toBe(true);
  });

  it('is not there while a content is being created', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    expect(dialog().querySelector('.content-modal__tags')).toBeNull();
  });
});

describe('the strip of the request for changes', () => {
  const STATES: Status[] = ['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled'];

  it.each(STATES)('a %s content shows it only when the state is "em ajuste"', async (status) => {
    await openContent(stored({ status }));

    expect(within(dialog()).queryByText('O cliente pediu ajuste.') !== null).toBe(status === 'adjusting');
    expect(within(dialog()).queryByRole('button', { name: 'Ver na conversa' }) !== null).toBe(status === 'adjusting');
  });

  it('takes the person to the conversation of the content and leaves the form untouched', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      await openContent(stored({ status: 'adjusting' }));
      type('Título', 'Ainda não salvo');
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Ver na conversa' }));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const conversation = dialog().querySelector('.content-modal__conversation');
      expect(scrollIntoView.mock.contexts[0]).toBe(conversation);
      expect(document.activeElement).toBe(conversation);
      expect((within(dialog()).getByLabelText('Título') as HTMLInputElement).value).toBe('Ainda não salvo');
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });
});

describe('the footer', () => {
  it.each([
    ['in_production', ['Enviar para aprovação']],
    ['awaiting_approval', ['Aprovar pela agência']],
    ['adjusting', ['Enviar para aprovação']],
    ['approved', ['Marcar como publicado']],
    ['published', []],
    ['cancelled', ['Reagendar']]
  ] as const)('a %s content leaves %j as the one filled button while nothing is waiting to be saved', async (status, expected) => {
    await openContent(stored({ status }), { permissions: EVERYTHING });

    expect(primaries()).toEqual(expected);
  });

  it('hands the filled button to Salvar as soon as the form has something to save, and gives it back when it has not', async () => {
    await openContent(stored({ status: 'awaiting_approval' }), { permissions: EVERYTHING });
    type('Título', 'Mudou');
    expect(primaries()).toEqual(['Salvar']);

    type('Título', 'Lançamento do pão');
    expect(primaries()).toEqual(['Aprovar pela agência']);
  });

  it('keeps "Cancelar conteúdo" out of the filled buttons, in every state that has it', async () => {
    for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const) {
      const view = await openContent(stored({ status }), { permissions: EVERYTHING });
      const cancel = within(footer()).getByRole('button', { name: 'Cancelar conteúdo' });

      expect(cancel.classList.contains('ui-button--ghost'), status).toBe(true);
      expect(cancel.classList.contains('content-actions__cancel'), status).toBe(true);
      view.unmount();
    }
  });

  it('submits the form from outside it, through the form attribute of Salvar', async () => {
    await openContent(stored());
    const form = dialog().querySelector<HTMLFormElement>('form.content-modal__form')!;
    const save = within(footer()).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;

    expect(form.contains(save)).toBe(false);
    expect(save.getAttribute('form')).toBe(form.id);
    expect(save.form).toBe(form);
  });

  it('keeps the moves in their own region and the form buttons out of it', async () => {
    await openContent(stored({ status: 'approved' }), { permissions: EVERYTHING });
    const region = within(footer()).getByRole('region', { name: 'Ações do conteúdo' });

    expect(within(region).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancelar conteúdo', 'Marcar como publicado']);
    expect(within(footer()).getByRole('button', { name: 'Fechar' }).closest('.content-actions')).toBeNull();
  });

  it('is the last thing of the Geral tab, after the conversation', async () => {
    await openContent(stored({ status: 'awaiting_approval' }));
    const conversation = dialog().querySelector('.content-modal__conversation')!;

    expect(conversation.compareDocumentPosition(footer()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer().closest('[role="tabpanel"]')).toBe(conversation.closest('[role="tabpanel"]'));
  });
});

describe('the dialog', () => {
  it('is the large Dialog of the design system, with the title in its own heading', async () => {
    const row = stored({ title: 'Cardápio de outono' });
    await openContent(row);

    expect(dialog().classList.contains('ui-modal--lg')).toBe(true);
    expect(within(dialog()).getByRole('heading', { level: 2, name: 'Cardápio de outono' })).toBeTruthy();
  });

  it('keeps one tab list, named, with Atribuição after Geral', async () => {
    await openContent(stored());
    const list = within(dialog()).getByRole('tablist', { name: 'Seções do conteúdo' });

    expect(within(list).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Geral', 'Atribuição']);
  });
});
