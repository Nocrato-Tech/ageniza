// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  base, contentPath, detailOf, dialog, IMG_1, IMG_2, IMG_3, json, makeFetch, openContent, render_, setupModalTests, stored, type, type Scenario, type Stored
} from './content-modal-fixture.js';

setupModalTests();

/** What only the agency holds: a subtask with its person and internal deadline, and the reason of an approval outside the platform. */
const withAgencyData = (row: Stored): Scenario => ({
  override: (call) => {
    if (call.method !== 'GET' || call.path !== contentPath(row.id)) return undefined;
    const detail = detailOf(row);
    return json({
      ...detail,
      approvedByAgencyReason: 'Cliente aprovou por telefone',
      tasks: [{ ...detail.tasks[0], title: 'Gravar bastidores', description: 'Briefing interno da equipe', dueOn: '2026-10-15', returnComment: 'Refazer o corte' }]
    });
  }
});

const openClientView = async (row: Stored, scenario: Scenario = {}): Promise<{ view: HTMLElement; calls: ReturnType<typeof makeFetch>['calls'] }> => {
  const opened = await openContent(row, scenario);
  fireEvent.click(within(dialog()).getByRole('tab', { name: 'Como o cliente vê' }));
  return { view: await screen.findByRole('region', { name: 'Como o cliente vê' }), calls: opened.calls };
};

describe('"Como o cliente vê" in the detail of a content (decision 2026-11-10)', () => {
  it('shows the post the way the portal shows it while it waits: title, state, format, day, caption and the choice of the client', async () => {
    const row = stored({ status: 'awaiting_approval', title: 'Lançamento do pão', publishAtTime: '09:30:00', caption: 'Pão fresquinho', media: [IMG_1.id], tasks: ['pending'] });
    const { view } = await openClientView(row);

    expect(within(view).getByRole('heading', { name: 'Lançamento do pão' })).toBeTruthy();
    expect(within(view).getByText('Aguardando aprovação')).toBeTruthy();
    expect(within(view).getByText('Imagem')).toBeTruthy();
    expect(within(view).getByText('terça-feira, 20 de outubro de 2026')).toBeTruthy();
    expect(view.textContent).toContain('09:30:00');
    expect(within(view).getByText('Pão fresquinho')).toBeTruthy();
    expect(within(view).getByText('O cliente pode aprovar ou pedir ajuste.')).toBeTruthy();
    expect(within(view).getByText(/Prévia do conteúdo como o portal o mostra agora\./)).toBeTruthy();
    expect(within(view).queryByText(/mídias, que o cliente passa/)).toBeNull();
  });

  it('says "Aprovado", the client\'s word, where the agency says "Pronto para publicar"', async () => {
    const { view } = await openClientView(stored({ status: 'approved', media: [IMG_1.id] }));

    expect(within(view).getByText('Aprovado')).toBeTruthy();
    expect(within(view).queryByText('Pronto para publicar')).toBeNull();
    expect(within(view).queryByText('O cliente pode aprovar ou pedir ajuste.')).toBeNull();
  });

  it('shows no agency-only data: not the subtasks, their person and deadline, the owner or the reason of an approval outside the platform', async () => {
    const row = stored({ status: 'awaiting_approval', media: [IMG_1.id], tasks: ['pending'] });
    const { view } = await openClientView(row, withAgencyData(row));

    expect(within(view).getByText('Lançamento do pão', { selector: 'h3' })).toBeTruthy();
    for (const hidden of ['Gravar bastidores', 'Briefing interno', 'Refazer o corte', 'Cliente aprovou por telefone', 'Ana Souza', '15/10', '2026-10-15', 'Subtarefa']) {
      expect(view.textContent).not.toContain(hidden);
    }
    expect(within(view).getByText(/Fica de fora para o cliente: subtarefas, responsável, prazo interno e a conversa da agência durante a produção\./)).toBeTruthy();
    expect(within(view).queryByRole('button')).toBeNull();
  });

  it('shows only the title, the day and the format while in production, with the reason, and no caption or media', async () => {
    const { view } = await openClientView(stored({ status: 'in_production', caption: 'Texto ainda interno', media: [IMG_1.id, IMG_2.id], publishAtTime: '09:30:00' }));

    expect(within(view).getByText('Em produção')).toBeTruthy();
    expect(within(view).getByText('terça-feira, 20 de outubro de 2026')).toBeTruthy();
    expect(within(view).getByText(/Em produção, o cliente vê só o título, o dia e o formato\./)).toBeTruthy();
    expect(view.textContent).not.toContain('Texto ainda interno');
    expect(view.textContent).not.toContain('09:30:00');
    expect(view.textContent).not.toContain('mídias');
    expect(view.querySelector('.content-preview__media')).toBeNull();
  });

  it('counts the media of a carousel and says when there is no caption or no media', async () => {
    const carousel = await openClientView(stored({ status: 'awaiting_approval', format: 'carousel', caption: null, media: [IMG_1.id, IMG_2.id, IMG_3.id] }));

    expect(within(carousel.view).getByText('3 mídias, que o cliente passa uma a uma.')).toBeTruthy();
    expect(within(carousel.view).getByText('Este post não tem legenda.')).toBeTruthy();
  });

  it('says when the content has no media yet', async () => {
    const { view } = await openClientView(stored({ status: 'awaiting_approval', media: [] }));

    expect(within(view).getByText('Este conteúdo ainda não tem mídia.')).toBeTruthy();
    expect(view.querySelector('.content-preview__media')).toBeNull();
  });

  it('shows the day it was published once it is published', async () => {
    const { view } = await openClientView(stored({ status: 'published', media: [IMG_1.id], publishedOn: '2026-10-09' }));

    expect(within(view).getByText('Publicado')).toBeTruthy();
    expect(within(view).getByText(/Publicado em/).textContent).toContain('sexta-feira, 9 de outubro de 2026');
  });

  it('says a cancelled content is not in the portal, and shows none of it', async () => {
    await openContent(stored({ status: 'cancelled', caption: 'Texto cancelado', media: [IMG_1.id] }));
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Como o cliente vê' }));

    const note = await screen.findByText('Este conteúdo foi cancelado: o cliente não o vê no portal.');
    expect(screen.queryByRole('region', { name: 'Como o cliente vê' })).toBeNull();
    expect(note.closest('[role="tabpanel"]')?.textContent).not.toContain('Texto cancelado');
  });

  it('shows the content as it is saved, not what is being typed in Geral, and keeps what was typed when the person comes back', async () => {
    const { view } = await openClientView(stored({ title: 'Título salvo', status: 'awaiting_approval', media: [IMG_1.id] }));
    expect(within(view).getByText('Título salvo', { selector: 'h3' })).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Geral' }));
    type('Título', 'Título novo ainda não salvo');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Como o cliente vê' }));

    const again = await screen.findByRole('region', { name: 'Como o cliente vê' });
    expect(within(again).getByText('Título salvo', { selector: 'h3' })).toBeTruthy();
    expect(again.textContent).not.toContain('Título novo ainda não salvo');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Geral' }));
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Título novo ainda não salvo');
  });

  it('never asks the portal for anything: the preview reads only the agency routes', async () => {
    const { calls } = await openClientView(stored({ status: 'awaiting_approval', media: [IMG_1.id] }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.filter((call) => call.path.startsWith('/clients/') || call.path.includes('/portal'))).toEqual([]);
  });

  it('is not offered before the content exists', async () => {
    const { impl } = makeFetch({});
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');

    expect(within(dialog()).getByRole('tab', { name: 'Como o cliente vê' }).hasAttribute('disabled')).toBe(true);
  });
});
