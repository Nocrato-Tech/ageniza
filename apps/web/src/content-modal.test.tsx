// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TODAY,
  AGENCY,
  json,
  failure,
  invalidField,
  VISUALIZE,
  READ_CLIENTS,
  EDITOR,
  padaria,
  barbearia,
  VIDEOS,
  IMAGES,
  LAUNCH,
  folder,
  asset,
  IMG_1,
  IMG_2,
  IMG_3,
  VID_1,
  FOLDERS,
  ASSETS,
  stored,
  detailOf,
  makeFetch,
  base,
  render_,
  dialog,
  field,
  type,
  click,
  writes,
  periodCalls,
  contentPath,
  calendarReady,
  openContent,
  setupModalTests,
  type Scenario,
  type Stored
} from './content-modal-fixture.js';

setupModalTests();

const closed = (): void => expect(screen.queryByRole('dialog')).toBeNull();
/** The folder chosen is read first; the form is saved only when the list on screen is the folder's. */
const savable = (): Promise<void> => waitFor(() => expect((within(dialog()).getByRole('button', { name: /^(Criar conteúdo|Salvar)$/ }) as HTMLButtonElement).disabled).toBe(false));

describe('the address of a content', () => {
  it('opens the modal from the shared address, with the form of that content, and again after a reload', async () => {
    const row = stored({ title: 'Lançamento do pão', publishAtTime: '18:00:00', caption: 'Pão fresquinho' });
    const { impl } = makeFetch({ contents: [row] });
    const first = render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByRole('heading', { name: 'Lançamento do pão' })).toBeTruthy();
    expect((field('Título') as HTMLInputElement).value).toBe('Lançamento do pão');
    expect((field('Data') as HTMLInputElement).value).toBe('20/10/2026');
    // The day uses the DatePicker of the other day fields of Conteúdos, not the native date input.
    expect((field('Data') as HTMLInputElement).type).toBe('text');
    expect(within(dialog()).getByRole('button', { name: 'Abrir calendário da data' })).toBeTruthy();
    expect((field('Hora') as HTMLInputElement).value).toBe('18:00');
    expect((field('Legenda') as HTMLTextAreaElement).value).toBe('Pão fresquinho');
    expect((field('Formato') as HTMLSelectElement).value).toBe('image');
    first.unmount();

    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByRole('heading', { name: 'Lançamento do pão' })).toBeTruthy();
    expect((field('Título') as HTMLInputElement).value).toBe('Lançamento do pão');
  });

  it('opens from the title of a card, keeps the period and the state of the roster, and closes back to the same calendar', async () => {
    const row = stored({ title: 'Receita longa', publishOn: '2026-10-21' });
    const other = stored({ title: 'Outro dia', publishOn: '2026-10-22' });
    const { impl } = makeFetch({ contents: [row, other] });
    const { probe } = render_(impl, { pathname: `${base()}`, state: { from: 'carteira' } });
    await calendarReady();
    await screen.findByText('Receita longa');
    probe.navigate(`${base()}?visao=semana&data=2026-10-21`, { state: { from: 'carteira' } });
    await screen.findByText('Receita longa');

    const link = screen.getAllByRole('link', { name: /Receita longa/ })[0]!;
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Receita longa/ })[0]!.getAttribute('href')).toBe(`${base()}/${row.id}?visao=semana&data=2026-10-21`));
    fireEvent.click(link);
    expect(await screen.findByRole('dialog', { name: 'Receita longa' })).toBeTruthy();
    expect(probe.pathname).toBe(`${base()}/${row.id}`);
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
    expect(probe.state).toEqual({ from: 'carteira' });

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(closed);
    expect(probe.pathname).toBe(base());
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
    expect(probe.state).toEqual({ from: 'carteira' });
  });

  it('opens the card of the second content, not of the first', async () => {
    const first = stored({ title: 'Primeiro', publishOn: '2026-10-20' });
    const second = stored({ title: 'Segundo', publishOn: '2026-10-20' });
    const { impl } = makeFetch({ contents: [first, second] });
    const { probe } = render_(impl);
    await screen.findAllByRole('link', { name: /Segundo/ });
    fireEvent.click(screen.getAllByRole('link', { name: /Segundo/ })[0]!);
    await screen.findByRole('dialog', { name: 'Segundo' });
    expect(probe.pathname).toBe(`${base()}/${second.id}`);
  });

  it.each([
    ['the API says 404', () => failure(404, 'NOT_FOUND')],
    ['the API says 403', () => failure(403, 'FORBIDDEN')]
  ])('says the content does not exist, in the screen\'s own words, when %s', async (_name, answer) => {
    const row = stored();
    const { impl } = makeFetch({
      contents: [row],
      override: (call) => (call.method === 'GET' && call.path === contentPath(row.id) ? answer() : undefined)
    });
    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('says the same for a malformed address, without asking the API for it', async () => {
    const { impl, calls } = makeFetch({ contents: [stored()] });
    render_(impl, `${base()}/nao-e-um-id`);
    expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
    expect(calls.some((call) => /\/contents\/nao-e-um-id/.test(call.path))).toBe(false);
  });

  it('does not show an answer that is about another content, or another client\'s', async () => {
    const row = stored();
    const elsewhere = stored({ title: 'De outro conteúdo' });
    // The same id, in another client: only the client of the address tells it apart.
    const foreign = { ...detailOf(row), title: 'De outro cliente', clientId: barbearia.id };
    for (const answer of [detailOf(elsewhere), foreign]) {
      const { impl } = makeFetch({
        contents: [row],
        override: (call) => (call.method === 'GET' && call.path === contentPath(row.id) ? json(answer) : undefined)
      });
      const view = render_(impl, `${base()}/${row.id}`);
      expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
      expect(screen.queryByText(answer.title)).toBeNull();
      view.unmount();
    }
  });

  it('shows the error with "Tentar de novo", and the retry brings the form back', async () => {
    const row = stored();
    let failing = true;
    const { impl } = makeFetch({
      contents: [row],
      override: (call) => (failing && call.method === 'GET' && call.path === contentPath(row.id) ? failure(500, 'INTERNAL') : undefined)
    });
    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByText('Não foi possível carregar o conteúdo. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    expect(await screen.findByLabelText('Título')).toBeTruthy();
  });

  it('opens on the Geral tab, with the Atribuição tab there to be opened (#265)', async () => {
    await openContent(stored());
    expect(within(dialog()).getByRole('tab', { name: 'Geral' }).getAttribute('aria-selected')).toBe('true');
    const assignment = within(dialog()).getByRole('tab', { name: 'Atribuição' });
    expect(assignment.getAttribute('aria-selected')).toBe('false');
    expect((assignment as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('who may edit', () => {
  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], false],
    ['conteudo.visualizar and conteudo.operar', EDITOR, true]
  ])('%s: the fields are enabled only for who operates', async (_name, permissions, editable) => {
    await openContent(stored(), { permissions });
    await waitFor(() => expect((field('Título') as HTMLInputElement).disabled).toBe(!editable));
    for (const label of ['Título', 'Formato', 'Data', 'Hora', 'Legenda']) expect(field(label).disabled).toBe(!editable);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' }) !== null).toBe(editable);
    expect(within(dialog()).queryByText('Você pode ver este conteúdo, mas não editar.') !== null).toBe(!editable);
  });

  it('is read-only on an archived client, with its own note', async () => {
    const row = stored({ clientId: barbearia.id });
    const { impl } = makeFetch({ contents: [row] });
    render_(impl, `${base(barbearia.id)}/${row.id}`);
    await screen.findByLabelText('Título');
    expect(await within(dialog()).findByText('Cliente arquivado: o conteúdo é só leitura.')).toBeTruthy();
    expect(field('Título').disabled).toBe(true);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it.each(['published', 'cancelled'] as const)('is read-only on a %s content, with its own note', async (status) => {
    await openContent(stored({ status }));
    expect(await within(dialog()).findByText('Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.')).toBeTruthy();
    expect(field('Título').disabled).toBe(true);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('shows the state of the content, in the agency\'s words', async () => {
    await openContent(stored({ status: 'approved' }));
    expect(within(dialog()).getByText('Pronto para publicar')).toBeTruthy();
  });
});

describe('editing', () => {
  it('sends only what changed, closes on success, and reads the calendar again', async () => {
    const row = stored({ publishAtTime: '18:00:00' });
    const { calls } = await openContent(row);
    type('Título', '  Pão novo  ');
    type('Hora', '19:30');
    type('Legenda', 'Pão fresquinho, quente');
    const before = periodCalls(calls).length;
    click('Salvar');

    await waitFor(closed);
    expect(writes(calls)).toEqual([{ method: 'PATCH', path: contentPath(row.id), body: { title: '  Pão novo  ', publishAtTime: '19:30', caption: 'Pão fresquinho, quente' } }]);
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
  });

  it('sends the day and clears the time with null, and a blank caption as null', async () => {
    const row = stored({ publishAtTime: '18:00:00' });
    const { calls } = await openContent(row);
    type('Data', '25/10/2026');
    type('Hora', '');
    type('Legenda', '   ');
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ publishOn: '2026-10-25', publishAtTime: null, caption: null });
  });

  it('keeps Salvar closed until something changes, and again when it is changed back', async () => {
    await openContent(stored());
    const save = within(dialog()).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type('Título', 'Outro');
    expect(save.disabled).toBe(false);
    type('Título', 'Lançamento do pão');
    expect(save.disabled).toBe(true);
  });

  it('does not close while the save is on its way, and closes when it answers', async () => {
    const row = stored();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { calls } = await openContent(row, {
      override: (call) => (call.method === 'PATCH' ? held.then(() => undefined) as never : undefined)
    });
    type('Título', 'Outro');
    click('Salvar');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar conteúdo' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    release();
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o conteúdo é só leitura.'],
    [409, 'CONTENT_NOT_EDITABLE', 'Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.'],
    [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Salve de novo.'],
    [409, 'CONTENT_MEDIA_INCOMPLETE', 'A mídia não cobre este formato. Depois do envio para aprovação, não se troca entre carrossel e uma mídia só: cancele e reagende o conteúdo.'],
    [400, 'CONTENT_MEDIA_INVALID', 'A mídia ou a capa escolhida não pode ser usada neste conteúdo.'],
    [400, 'CONTENT_FOLDER_INVALID', 'A pasta escolhida não é uma pasta deste cliente.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para alterar conteúdos.'],
    [404, 'NOT_FOUND', 'Este conteúdo não existe mais.'],
    [500, 'INTERNAL', 'Não foi possível salvar o conteúdo. Tente de novo.']
  ])('answers %s %s with its own words, keeps the modal open and keeps what was typed', async (status, code, text) => {
    const row = stored();
    await openContent(row, { override: (call) => (call.method === 'PATCH' ? failure(status, code) : undefined) });
    type('Título', 'Título que eu digitei');
    type('Legenda', 'Legenda que eu digitei');
    click('Salvar');

    expect((await within(dialog()).findAllByRole('alert')).some((alert) => alert.textContent === text)).toBe(true);
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect((field('Título') as HTMLInputElement).value).toBe('Título que eu digitei');
    expect((field('Legenda') as HTMLTextAreaElement).value).toBe('Legenda que eu digitei');
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('marks the field the API refused, in the screen\'s own words', async () => {
    const row = stored();
    await openContent(row, { override: (call) => (call.method === 'PATCH' ? invalidField('caption') : undefined) });
    type('Legenda', 'Algo que o servidor recusa');
    click('Salvar');

    const message = await within(dialog()).findByText('A legenda não foi aceita. Revise o texto.');
    expect(message.getAttribute('role')).toBe('alert');
    expect(field('Legenda').getAttribute('aria-invalid')).toBe('true');
    expect(field('Título').getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(within(dialog()).getByText('Revise os campos marcados.')).toBeTruthy();
  });

  it('clears the mark of a field when that field is edited again', async () => {
    await openContent(stored(), { override: (call) => (call.method === 'PATCH' ? invalidField('title') : undefined) });
    type('Título', 'Recusado');
    click('Salvar');
    await within(dialog()).findByText('O título não foi aceito. Revise o texto.');
    type('Título', 'Aceito');
    expect(within(dialog()).queryByText('O título não foi aceito. Revise o texto.')).toBeNull();
  });

  it.each([
    ['an empty title', 'Título', '   ', 'Informe o título.'],
    ['a title of 121 characters', 'Título', 'a'.repeat(121), 'O título passa de 120 caracteres.'],
    ['a title with an invisible character', 'Título', 'Pão​novo', 'O título tem caracteres que não são aceitos.'],
    ['a caption of 2.201 characters', 'Legenda', 'a'.repeat(2201), 'A legenda passa de 2.200 caracteres.'],
    ['a caption with an invisible character', 'Legenda', 'oi‮tchau', 'A legenda tem caracteres que não são aceitos.'],
    ['no day', 'Data', '', 'Informe o dia da publicação.']
  ])('sends nothing for %s, and says why', async (_name, label, value, text) => {
    const { calls } = await openContent(stored());
    type(label, value);
    click('Salvar');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it('accepts a title of 120 characters and a caption of 2.200, counted as people count (an emoji is one)', async () => {
    const { calls } = await openContent(stored());
    type('Título', '😀'.repeat(120));
    type('Legenda', '😀'.repeat(2200));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)).toHaveLength(1);
  });

  it('counts the caption as people read it, with the thousands separator', async () => {
    await openContent(stored({ caption: null }));
    expect(within(dialog()).getByText('0/2.200')).toBeTruthy();
    type('Legenda', 'a'.repeat(1204));
    expect(within(dialog()).getByText('1.204/2.200')).toBeTruthy();
    type('Legenda', '😀😀😀');
    expect(within(dialog()).getByText('3/2.200')).toBeTruthy();
  });

  it('shows the post as it is typed: title, caption, format, day (in São Paulo) and time', async () => {
    await openContent(stored({ title: 'Lançamento do pão', caption: 'Pão fresquinho', publishAtTime: null }));
    const preview = within(dialog()).getByRole('figure', { name: 'Prévia do post' });
    expect(within(preview).getByText('@padariacentral')).toBeTruthy();
    expect(within(preview).getByText('Lançamento do pão')).toBeTruthy();
    expect(within(preview).getByText('terça-feira, 20 de outubro de 2026')).toBeTruthy();

    type('Título', 'Pão de queijo');
    type('Legenda', 'Linha 1\nLinha 2');
    type('Formato', 'reels');
    type('Data', '25/10/2026');
    type('Hora', '09:15');
    expect(within(preview).getByText('Pão de queijo')).toBeTruthy();
    expect(within(preview).getByText((_text, element) => element?.tagName === 'P' && element.textContent === 'Linha 1\nLinha 2')).toBeTruthy();
    expect(within(preview).getByText('Reels')).toBeTruthy();
    expect(preview.querySelector('.content-preview__when')?.textContent).toBe('domingo, 25 de outubro de 2026 · 09:15');
    type('Legenda', '');
    expect(within(preview).getByText('Sem legenda')).toBeTruthy();
  });

  it.each([
    ['approved', 'the caption', 'Legenda', 'Outra legenda', true],
    ['approved', 'the format', 'Formato', 'carousel', true],
    ['approved', 'the title only', 'Título', 'Outro título', false],
    ['approved', 'the time only', 'Hora', '10:00', false],
    ['approved', 'the day only', 'Data', '27/10/2026', false],
    ['in_production', 'the caption', 'Legenda', 'Outra legenda', false],
    ['adjusting', 'the caption', 'Legenda', 'Outra legenda', false]
  ] as const)('a %s content, when you change %s, %s the warning that it goes back to waiting for approval', async (status, _what, label, value, warns) => {
    await openContent(stored({ status }));
    type(label, value);
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/) !== null).toBe(warns);
  });

  it('names what goes back in the warning of an approved content, and the save is what the API does', async () => {
    const row = stored({ status: 'approved' });
    const { calls, contents } = await openContent(row);
    type('Legenda', 'Outra legenda');
    expect(within(dialog()).getByText('Este conteúdo está aprovado. Mudar a legenda, a mídia, a capa, a pasta ou o formato o devolve para “Aguardando aprovação”.')).toBeTruthy();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ caption: 'Outra legenda' });
    expect(contents.find((content) => content.id === row.id)!.status).toBe('awaiting_approval');
  });

  it('warns for a change of the media of an approved content', async () => {
    await openContent(stored({ status: 'approved', format: 'reels', folderId: VIDEOS }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Vídeo de 06/10' }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).not.toBeNull();
  });

  it('warns for a change of the cover of an approved content, and not for the title beside it', async () => {
    await openContent(stored({ status: 'approved', format: 'reels', folderId: LAUNCH }));
    type('Título', 'Só o título');
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Usar Imagem de 09/10 como capa' }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).not.toBeNull();
  });
});

describe('the folder and the media', () => {
  it('reads every page of folders and of media: the 101st is there', async () => {
    const many = Array.from({ length: 101 }, (_value, index) => folder(`f3f3f3f3-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `Pasta ${index + 1}`));
    const images = Array.from({ length: 101 }, (_value, index) => asset(100 + index, 'image', '10'));
    const row = stored({ folderId: many[0]!.id });
    const { calls } = await openContent(row, { folders: many, assets: { [many[0]!.id]: images } });
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(102));
    expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Pasta 101' })).toBeTruthy();
    await waitFor(() => expect(within(dialog()).getAllByRole('button', { name: /^Adicionar Imagem de 10\/10$/ })).toHaveLength(101));
    expect(calls.filter((call) => /media-folders\?/.test(call.path)).map((call) => call.path.split('?')[1])).toEqual(['page=1&pageSize=100', 'page=2&pageSize=100']);
  });

  it('names a working folder with the one it lives in', async () => {
    await openContent(stored());
    await within(dialog()).findByLabelText('Pasta');
    const select = field('Pasta') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Escolha a pasta', 'Vídeos', 'Imagens', 'Vídeos / Lançamento']));
    expect(select.value).toBe(IMAGES);
  });

  it('lists only the media that fits the format: images for an image, videos for a video, both for a carousel', async () => {
    await openContent(stored({ folderId: LAUNCH, format: 'image' }));
    expect(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeNull();
    type('Formato', 'reels');
    expect(within(dialog()).queryByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeNull();
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeTruthy();
    type('Formato', 'carousel');
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeTruthy();
  });

  it('says the folder has no media for the format, in its own words', async () => {
    await openContent(stored({ folderId: VIDEOS, format: 'image' }));
    expect(await within(dialog()).findByText('Esta pasta não tem imagens para este formato.')).toBeTruthy();
  });

  it('a format that takes one media replaces it when another is added', async () => {
    const row = stored();
    const { calls } = await openContent(row);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    expect(within(dialog()).getAllByText(/^Mídia \d$/)).toHaveLength(1);
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_2.id] });
  });

  it('a carousel keeps the order that was made by hand, and sends the whole list', async () => {
    const row = stored({ format: 'carousel' });
    const { calls } = await openContent(row);
    for (const label of ['03/10', '04/10', '05/10']) fireEvent.click(await within(dialog()).findByRole('button', { name: `Adicionar Imagem de ${label}` }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover mídia 3 para antes' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Tirar mídia 1' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_3.id, IMG_2.id] });
  });

  it('sends the new order when two media of a carousel change places', async () => {
    const row = stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] });
    const { calls } = await openContent(row);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover mídia 2 para antes' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_2.id, IMG_1.id] });
  });

  it('shows the cover of a video in the preview, and its first video once the cover is off', async () => {
    const cover = asset(7, 'image', '09').id;
    const video = asset(6, 'video', '08').id;
    await openContent(stored({ format: 'reels', folderId: LAUNCH, media: [video], coverAssetId: cover }));
    const preview = within(dialog()).getByRole('figure', { name: 'Prévia do post' });
    await waitFor(() => expect(preview.querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${cover}.jpg`));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Tirar a capa' }));
    await waitFor(() => expect(preview.querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${video}.jpg`));
  });

  it('does not offer to add the same media twice', async () => {
    await openContent(stored({ format: 'carousel' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' }));
    expect((within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 03/10' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the first media that fits when a carousel becomes a format of one media', async () => {
    const { calls } = await openContent(stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
    type('Formato', 'image');
    await waitFor(() => expect(within(dialog()).getAllByText(/^Mídia \d$/)).toHaveLength(1));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ format: 'image', mediaAssetIds: [IMG_1.id] });
  });

  it('sends the format and the media of a change of format in the same request', async () => {
    const row = stored({ format: 'image', media: [IMG_1.id] });
    const { calls } = await openContent(row);
    type('Formato', 'carousel');
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ format: 'carousel', mediaAssetIds: [IMG_1.id, IMG_2.id] });
  });

  it('a cover belongs to a video only: it is chosen, removed, and gone when the format stops being a video', async () => {
    const row = stored({ format: 'reels', folderId: LAUNCH, media: [] });
    const { calls } = await openContent(row);
    expect(within(dialog()).getByRole('group', { name: 'Capa' })).toBeTruthy();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Usar Imagem de 09/10 como capa' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ coverAssetId: asset(7, 'image', '09').id });
  });

  it('takes the cover off with null, and drops it when the format becomes an image', async () => {
    const cover = asset(7, 'image', '09').id;
    const row = stored({ format: 'reels', folderId: LAUNCH, coverAssetId: cover });
    const { calls } = await openContent(row);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Tirar a capa' }));
    expect(within(dialog()).getByText('Sem capa: vale o quadro automático do vídeo.')).toBeTruthy();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ coverAssetId: null });
  });

  it('drops the cover with the format that has none, in the same request', async () => {
    const cover = asset(7, 'image', '09').id;
    const { calls } = await openContent(stored({ format: 'reels', folderId: LAUNCH, coverAssetId: cover }));
    type('Formato', 'image');
    expect(within(dialog()).queryByRole('group', { name: 'Capa' })).toBeNull();
    await waitFor(() => expect(within(dialog()).getAllByText(/^Mídia \d$/)).toHaveLength(1));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ format: 'image', coverAssetId: null, mediaAssetIds: [asset(7, 'image', '09').id] });
  });

  it('changes the folder of a content with no media, asks nothing, and sends the folder with the list on screen', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', VIDEOS);
    expect(within(dialog()).queryByRole('group', { name: 'Trocar a pasta' })).toBeNull();
    expect((field('Pasta') as HTMLSelectElement).value).toBe(VIDEOS);
    await savable();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ folderId: VIDEOS, mediaAssetIds: [] });
  });

  it('creates a folder inside the first level, chooses it, and sends the name and the parent', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Verão');
    type('Dentro de', VIDEOS);
    click('Criar pasta');

    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Vídeos / Verão' })).toBeTruthy());
    expect(calls.filter((call) => call.method === 'POST')[0]).toEqual({
      method: 'POST', path: `/agencies/${AGENCY}/clients/${padaria.id}/media-folders`, body: { name: 'Verão', parentId: VIDEOS }
    });
    expect((field('Pasta') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Vídeos / Verão');
    expect(within(dialog()).queryByLabelText('Nome da pasta')).toBeNull();
  });

  it('asks before taking a folder that was just created when the content has media, and changes nothing until the person confirms', async () => {
    const { calls } = await openContent(stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Verão');
    click('Criar pasta');

    const confirmation = await within(dialog()).findByRole('group', { name: 'Trocar a pasta' });
    expect(within(confirmation).getByText('Trocar para Verão?')).toBeTruthy();
    expect((field('Pasta') as HTMLSelectElement).value).toBe(IMAGES);
    expect(dialog().querySelectorAll('.content-media__selected .content-media__tile')).toHaveLength(2);
    // The folder itself was created; the content was not touched.
    expect(writes(calls).filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('creates a first-level folder with no parent in the body', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Promoções');
    click('Criar pasta');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Promoções' })).toBeTruthy());
    expect(calls.filter((call) => call.method === 'POST')[0]!.body).toEqual({ name: 'Promoções' });
  });

  it.each([
    ['an empty name', '  ', undefined, 'Informe o nome da pasta.'],
    ['a name with an invisible character', 'Pa​sta', undefined, 'O nome da pasta tem caracteres que não são aceitos, ou passa de 80 caracteres.']
  ])('sends nothing for a folder with %s', async (_name, value, _x, text) => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', value);
    click('Criar pasta');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: não é possível criar pastas.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para criar pastas.'],
    [400, 'VALIDATION_ERROR', 'O nome da pasta tem caracteres que não são aceitos, ou passa de 80 caracteres.'],
    [500, 'INTERNAL', 'Não foi possível criar a pasta. Tente de novo.']
  ])('answers %s %s to a new folder with its own words, and keeps the name', async (status, code, text) => {
    await openContent(stored(), { override: (call) => (call.method === 'POST' && /media-folders$/.test(call.path) ? failure(status, code) : undefined) });
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Verão');
    click('Criar pasta');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect((field('Nome da pasta') as HTMLInputElement).value).toBe('Verão');
  });

  it('shows the error of the folders with "Tentar de novo"', async () => {
    let failing = true;
    await openContent(stored(), { override: (call) => (failing && /media-folders\?/.test(call.path) ? failure(500, 'INTERNAL') : undefined) });
    expect(await within(dialog()).findByText('Não foi possível carregar as pastas. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
  });

  it('shows the error of the media of the folder with "Tentar de novo"', async () => {
    let failing = true;
    await openContent(stored(), { override: (call) => (failing && /\/assets\?/.test(call.path) ? failure(500, 'INTERNAL') : undefined) });
    expect(await within(dialog()).findByText('Não foi possível carregar as mídias da pasta. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    expect(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' })).toBeTruthy();
  });

  it('draws no way to add media or a folder for who only reads', async () => {
    await openContent(stored(), { permissions: [VISUALIZE, READ_CLIENTS] });
    await waitFor(() => expect((field('Pasta') as HTMLSelectElement).disabled).toBe(true));
    expect(within(dialog()).queryByRole('button', { name: /^Adicionar / })).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Nova pasta' })).toBeNull();
  });
});

describe('the folder is a drive: choosing it gives the content what it holds', () => {
  const ready = (): Promise<void> => waitFor(() => expect((within(dialog()).getByRole('button', { name: /^(Criar conteúdo|Salvar)$/ }) as HTMLButtonElement).disabled).toBe(false));
  const selected = (): string[] => Array.from(dialog().querySelectorAll('.content-media__selected .content-media__tile')).map((tile) => tile.textContent ?? '');

  it('puts the first image of the folder in an image, and the first video in a reels', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', IMAGES);
    await waitFor(() => expect(selected()).toHaveLength(1));
    type('Formato', 'reels');
    type('Pasta', VIDEOS);
    await waitFor(() => expect(selected()).toHaveLength(1));
    expect(within(dialog()).queryByText('Esta pasta não tem vídeos para este formato.')).toBeNull();
  });

  it('puts every media of the folder in a carousel, and sends them in the creation itself', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Carrossel');
    type('Formato', 'carousel');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', IMAGES);
    await waitFor(() => expect(selected()).toHaveLength(3));
    await ready();
    click('Criar conteúdo');
    await waitFor(closed);
    expect(writes(calls)).toHaveLength(1);
    expect((writes(calls)[0]!.body as { mediaAssetIds: string[] }).mediaAssetIds).toEqual([IMG_1.id, IMG_2.id, IMG_3.id]);
  });

  it('says an empty folder is empty and where to send the first media, and creates the content without media', async () => {
    const empty = 'f1f1f1f1-0000-4000-8000-000000000009';
    const { impl, calls } = makeFetch({ folders: [...FOLDERS, folder(empty, 'Vazia')], assets: { ...ASSETS, [empty]: [] } });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Sem mídia ainda');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
    type('Pasta', empty);
    expect(await within(dialog()).findByText('Esta pasta está vazia. Envie a primeira mídia por aqui.')).toBeTruthy();
    await ready();
    click('Criar conteúdo');
    await waitFor(closed);
    expect((writes(calls)[0]!.body as { mediaAssetIds: string[] }).mediaAssetIds).toEqual([]);
  });

  it('does not create before the folder is read, and says so when it cannot be read', async () => {
    let failing = true;
    const { impl, calls } = makeFetch({
      override: (call) => (failing && call.method === 'GET' && /media-folders\/[^/]+\/assets/.test(call.path) ? failure(500, 'INTERNAL') : undefined)
    });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Pão');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', IMAGES);
    expect(await within(dialog()).findByText('Não foi possível ler a pasta. Tente de novo.')).toBeTruthy();
    expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(true);
    // Enter in a field submits the form without the button: that must not create the content on a list that was never read either.
    fireEvent.submit(dialog().querySelector('form')!);
    expect(writes(calls)).toHaveLength(0);
    failing = false;
    type('Pasta', VIDEOS);
    await ready();
    expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads the same folder again from "Ler a pasta de novo", which clears the error and frees the save', async () => {
    let failing = true;
    const { impl, calls } = makeFetch({
      override: (call) => (failing && call.method === 'GET' && /media-folders\/[^/]+\/assets/.test(call.path) ? failure(500, 'INTERNAL') : undefined)
    });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Pão');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', IMAGES);
    expect(await within(dialog()).findByText('Não foi possível ler a pasta. Tente de novo.')).toBeTruthy();
    const reads = calls.filter((call) => call.method === 'GET' && /media-folders\/[^/]+\/assets/.test(call.path)).length;

    failing = false;
    click('Ler a pasta de novo');
    await ready();
    expect(within(dialog()).queryByText('Não foi possível ler a pasta. Tente de novo.')).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Ler a pasta de novo' })).toBeNull();
    expect(calls.filter((call) => call.method === 'GET' && /media-folders\/[^/]+\/assets/.test(call.path)).length).toBeGreaterThan(reads);
    expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('refits the media to a new format: what fits stays, and a folder without the kind gives its own', async () => {
    await openContent(stored({ format: 'carousel', folderId: LAUNCH, media: [asset(7, 'image', '09').id, asset(6, 'video', '08').id] }));
    await waitFor(() => expect(selected()).toHaveLength(2));
    type('Formato', 'reels');
    await waitFor(() => expect(selected()).toHaveLength(1));
    type('Formato', 'image');
    await waitFor(() => expect(within(dialog()).queryByText('Esta pasta não tem imagens para este formato.')).toBeNull());
    await waitFor(() => expect(selected()).toHaveLength(1));
  });

  describe('changing the folder of a content that has media', () => {
    const swap = async (row: Stored) => {
      const opened = await openContent(row);
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
      type('Pasta', VIDEOS);
      return opened;
    };
    const confirmation = (): HTMLElement => within(dialog()).getByRole('group', { name: 'Trocar a pasta' });

    it('asks first, says what leaves and what enters, and changes nothing until the person confirms', async () => {
      const { calls } = await swap(stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
      expect(within(confirmation()).getByText('Trocar para Vídeos?')).toBeTruthy();
      expect(within(confirmation()).getByText('A mídia de agora sai do conteúdo, e entra a da pasta nova.')).toBeTruthy();
      expect((field('Pasta') as HTMLSelectElement).value).toBe(IMAGES);
      expect(selected()).toHaveLength(2);
      expect(writes(calls)).toHaveLength(0);
    });

    it('keeps the folder when the person keeps it', async () => {
      await swap(stored({ format: 'carousel', media: [IMG_1.id] }));
      fireEvent.click(within(confirmation()).getByRole('button', { name: 'Manter a pasta atual' }));
      expect(within(dialog()).queryByRole('group', { name: 'Trocar a pasta' })).toBeNull();
      expect((field('Pasta') as HTMLSelectElement).value).toBe(IMAGES);
      expect(selected()).toHaveLength(1);
    });

    it('takes the media of the new folder when confirmed, with the cover gone, and saves them in one request', async () => {
      const cover = asset(7, 'image', '09').id;
      const { calls, contents } = await swap(stored({ format: 'reels', folderId: LAUNCH, media: [asset(6, 'video', '08').id], coverAssetId: cover }));
      expect(within(confirmation()).getByText('A mídia e a capa de agora saem do conteúdo, e entram as da pasta nova.')).toBeTruthy();
      fireEvent.click(within(confirmation()).getByRole('button', { name: 'Trocar a pasta' }));
      expect((field('Pasta') as HTMLSelectElement).value).toBe(VIDEOS);
      await waitFor(() => expect(selected()).toHaveLength(1));
      await ready();
      click('Salvar');
      await waitFor(closed);
      expect(writes(calls)[0]!.body).toEqual({ folderId: VIDEOS, coverAssetId: null, mediaAssetIds: [VID_1.id] });
      expect(contents[0]!.folderId).toBe(VIDEOS);
      expect(contents[0]!.media).toEqual([VID_1.id]);
      expect(contents[0]!.coverAssetId).toBeNull();
    });

    it('says an approved content goes back to "aguardando aprovação"', async () => {
      await swap(stored({ status: 'approved', format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
      expect(within(confirmation()).getByText(/O conteúdo está aprovado e volta para “Aguardando aprovação”\./)).toBeTruthy();
    });

    it('says a content that waits stays waiting, and that it does not stay without media', async () => {
      await swap(stored({ status: 'awaiting_approval', format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
      expect(within(confirmation()).getByText(/Um conteúdo enviado para aprovação não fica sem mídia/)).toBeTruthy();
      expect(within(confirmation()).queryByText(/está aprovado/)).toBeNull();
    });

    it('answers a folder that cannot fill a content that waits with its own words, and keeps what is on screen', async () => {
      const empty = 'f1f1f1f1-0000-4000-8000-000000000009';
      const row = stored({ status: 'awaiting_approval', format: 'carousel', media: [IMG_1.id, IMG_2.id] });
      const { calls } = await openContent(row, { folders: [...FOLDERS, folder(empty, 'Vazia')], assets: { ...ASSETS, [empty]: [] } });
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', empty);
      fireEvent.click(within(confirmation()).getByRole('button', { name: 'Trocar a pasta' }));
      await ready();
      click('Salvar');
      expect((await within(dialog()).findAllByRole('alert')).some((alert) => /não tem mídia que complete o formato/.test(alert.textContent ?? ''))).toBe(true);
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
      expect(writes(calls)).toHaveLength(1);
      expect(screen.queryByRole('dialog')).not.toBeNull();
    });

    it('asks nothing of a content in production that has no media and no cover', async () => {
      await openContent(stored());
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
      type('Pasta', VIDEOS);
      expect(within(dialog()).queryByRole('group', { name: 'Trocar a pasta' })).toBeNull();
    });
  });

  describe('sending a file from the modal', () => {
    class FakeXhr {
      public upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number }) => void) };
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public onabort: (() => void) | null = null;
      public status = 200;
      public open(): void { /* the storage is the fake's */ }
      public setRequestHeader(): void { /* not needed */ }
      public getResponseHeader(): string | null { return null; }
      public abort(): void { this.onabort?.(); }
      public send(): void {
        if (slow.held) { slow.finish = () => this.onload?.(); return; }
        queueMicrotask(() => this.onload?.());
      }
    }
    // A real upload ends in a macrotask, long after the person has kept working; `held` keeps it open until the test lets it go.
    const slow: { held: boolean; finish: (() => void) | null } = { held: false, finish: null };
    beforeEach(() => { slow.held = false; slow.finish = null; vi.stubGlobal('XMLHttpRequest', FakeXhr); });
    afterEach(() => { vi.unstubAllGlobals(); });

    const sendFile = async (file: File): Promise<void> => {
      const input = await within(dialog()).findByLabelText('Enviar mídia');
      fireEvent.change(input, { target: { files: [file] } });
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar' }));
    };

    it('lands in the folder and enters the content, then is saved with the content', async () => {
      const empty = 'f1f1f1f1-0000-4000-8000-000000000009';
      const { impl, calls } = makeFetch({ folders: [...FOLDERS, folder(empty, 'Vazia')], assets: { ...ASSETS, [empty]: [] } });
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      type('Título', 'Com envio');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', empty);
      await sendFile(new File([new Uint8Array(2_000)], 'foto.jpg', { type: 'image/jpeg' }));

      await waitFor(() => expect(selected()).toHaveLength(1));
      const upload = calls.find((call) => call.method === 'POST' && /media\/uploads$/.test(call.path));
      expect(upload?.body).toMatchObject({ fileName: 'foto.jpg', contentType: 'image/jpeg', clientId: padaria.id, folderId: empty });
      await ready();
      click('Criar conteúdo');
      await waitFor(closed);
      const created = writes(calls).find((call) => /contents$/.test(call.path));
      expect((created?.body as { mediaAssetIds: string[] }).mediaAssetIds).toHaveLength(1);
      expect((created?.body as { folderId: string }).folderId).toBe(empty);
    });

    it('replaces the media of a format of one media, and does not pass twenty in a carousel', async () => {
      const big = 'f1f1f1f1-0000-4000-8000-000000000008';
      const twenty = Array.from({ length: 20 }, (_, n) => asset(100 + n, 'image', '10'));
      const { impl, calls } = makeFetch({ folders: [...FOLDERS, folder(big, 'Cheia')], assets: { ...ASSETS, [big]: twenty } });
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      type('Título', 'Cheio');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', big);
      await waitFor(() => expect(selected()).toHaveLength(1));
      await sendFile(new File([new Uint8Array(2_000)], 'nova.jpg', { type: 'image/jpeg' }));
      await waitFor(() => expect(calls.some((call) => /uploads\/[^/]+\/complete$/.test(call.path))).toBe(true));
      await savable();
      // An image takes one: the file sent takes the place of the one inherited.
      await waitFor(() => expect(selected()).toHaveLength(1));
      click('Criar conteúdo');
      await waitFor(closed);
      const body = writes(calls).find((call) => /contents$/.test(call.path))!.body as { mediaAssetIds: string[] };
      expect(body.mediaAssetIds).toHaveLength(1);
      expect(body.mediaAssetIds[0]).not.toBe(twenty[19]!.id);
    });

    it('puts the file in the list as it is when the upload ends, not as it was when it began', async () => {
      const three = 'f1f1f1f1-0000-4000-8000-000000000007';
      const assets = Array.from({ length: 3 }, (_, n) => asset(200 + n, 'image', '10'));
      const { impl } = makeFetch({ folders: [...FOLDERS, folder(three, 'Tres')], assets: { ...ASSETS, [three]: assets } });
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      type('Formato', 'carousel');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', three);
      await waitFor(() => expect(selected()).toHaveLength(3));
      slow.held = true;
      await sendFile(new File([new Uint8Array(2_000)], 'extra.jpg', { type: 'image/jpeg' }));
      await waitFor(() => expect(slow.finish).not.toBeNull());
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Tirar mídia 1' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Tirar mídia 1' }));
      expect(selected()).toHaveLength(1);
      await act(async () => { slow.finish?.(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      await waitFor(() => expect(selected()).toHaveLength(2));
    });

    it('does not save while the file goes up, not even with Enter, and says why', async () => {
      const empty = 'f1f1f1f1-0000-4000-8000-000000000009';
      const { impl, calls } = makeFetch({ folders: [...FOLDERS, folder(empty, 'Vazia')], assets: { ...ASSETS, [empty]: [] } });
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      type('Título', 'Com envio');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', empty);
      await ready();
      slow.held = true;
      await sendFile(new File([new Uint8Array(2_000)], 'foto.jpg', { type: 'image/jpeg' }));
      await waitFor(() => expect(slow.finish).not.toBeNull());
      expect(within(dialog()).getByText('Aguarde o envio da mídia terminar para salvar o conteúdo.')).toBeTruthy();
      expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(field('Título').closest('form')!);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(writes(calls).filter((call) => /contents$/.test(call.path))).toHaveLength(0);
      expect(screen.queryByRole('dialog')).not.toBeNull();
      await act(async () => { slow.finish?.(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      await waitFor(() => expect(selected()).toHaveLength(1));
      await waitFor(() => expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(false));
      expect(within(dialog()).queryByText('Aguarde o envio da mídia terminar para salvar o conteúdo.')).toBeNull();
    });

    it('does not put a twenty-first media in a carousel, and says why', async () => {
      const big = 'f1f1f1f1-0000-4000-8000-000000000008';
      const twenty = Array.from({ length: 20 }, (_, n) => asset(100 + n, 'image', '10'));
      const { impl } = makeFetch({ folders: [...FOLDERS, folder(big, 'Cheia')], assets: { ...ASSETS, [big]: twenty } });
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      type('Formato', 'carousel');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(5));
      type('Pasta', big);
      await waitFor(() => expect(selected()).toHaveLength(20));
      await sendFile(new File([new Uint8Array(2_000)], 'extra.jpg', { type: 'image/jpeg' }));
      expect(await within(dialog()).findByText('A mídia foi para a pasta, mas um carrossel leva até 20 mídias.')).toBeTruthy();
      expect(selected()).toHaveLength(20);
    });

    it('keeps a video that the format does not take in the folder, and says so', async () => {
      const { impl } = makeFetch();
      render_(impl, `${base()}/novo`);
      await screen.findByLabelText('Título');
      await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
      type('Pasta', IMAGES);
      await waitFor(() => expect(selected()).toHaveLength(1));
      await sendFile(new File([new Uint8Array(2_000)], 'filme.mp4', { type: 'video/mp4' }));
      expect(await within(dialog()).findByText('A mídia foi para a pasta, mas o formato Imagem não usa vídeo.')).toBeTruthy();
      expect(selected()).toHaveLength(1);
    });
  });
});

describe('creating a content', () => {
  const createButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Novo conteúdo' });
  /** The folder is read when it is chosen, and the content is not created before the list on screen is the folder's. */
  const readyToCreate = (): Promise<void> => waitFor(() => expect((within(dialog()).getByRole('button', { name: 'Criar conteúdo' }) as HTMLButtonElement).disabled).toBe(false));

  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], false],
    ['conteudo.operar with visualizar', EDITOR, true]
  ])('%s: the "Novo conteúdo" button exists only for who operates', async (_name, permissions, shown) => {
    const { impl } = makeFetch({ permissions });
    render_(impl);
    await calendarReady();
    await waitFor(() => expect(createButton() !== null).toBe(shown));
  });

  it('has no "Novo conteúdo" on an archived client', async () => {
    const { impl } = makeFetch();
    render_(impl, base(barbearia.id));
    await calendarReady();
    await screen.findByText('Cliente arquivado: o calendário é só leitura.');
    expect(createButton()).toBeNull();
  });

  it('opens on today in São Paulo, with the address that says so', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl);
    await calendarReady();
    fireEvent.click(await screen.findByRole('button', { name: 'Novo conteúdo' }));

    expect(await screen.findByRole('dialog', { name: 'Novo conteúdo' })).toBeTruthy();
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe(TODAY.split('-').reverse().join('/'));
    expect(probe.pathname).toBe(`${base()}/novo`);
    expect(probe.search).toBe(`?dia=${TODAY}`);
  });

  it('opens from the "Conteúdo" of the + of a day, on that day, and keeps it after a reload', async () => {
    const { impl } = makeFetch();
    const first = render_(impl);
    await calendarReady();
    const plus = within(document.querySelector('.content-day time[datetime="2026-10-22"], .content-agenda__day time[datetime="2026-10-22"]')!.closest('li')!).getByRole('button', { name: /^Adicionar no dia/ });
    fireEvent.click(plus);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Conteúdo' }));

    expect(await screen.findByRole('dialog', { name: 'Novo conteúdo' })).toBeTruthy();
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe('22/10/2026');
    expect(first.probe.search).toBe('?dia=2026-10-22');
    first.unmount();

    render_(impl, `${base()}/novo?dia=2026-10-22`);
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe('22/10/2026');
  });

  it('keeps the period of the calendar in the address, and drops the day of the "+" when it closes', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl, `${base()}/novo?visao=semana&data=2026-10-21&dia=2026-10-22`);
    await screen.findByLabelText('Data');
    click('Fechar');
    await waitFor(closed);
    expect(probe.pathname).toBe(base());
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
  });

  it.each(['2026-02-30', 'amanhã', ''])('falls back to today when the day of the address is "%s"', async (day) => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo?dia=${day}`);
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe(TODAY.split('-').reverse().join('/'));
  });

  it('sends the content as typed, closes, and the new card is on the calendar', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `${base()}/novo?dia=2026-10-22`);
    await screen.findByLabelText('Título');
    type('Título', '  Pão de queijo  ');
    type('Formato', 'reels');
    type('Hora', '09:15');
    type('Legenda', 'Quentinho');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', VIDEOS);
    await readyToCreate();
    click('Criar conteúdo');

    await waitFor(closed);
    expect(writes(calls)).toEqual([{
      method: 'POST',
      path: `/agencies/${AGENCY}/clients/${padaria.id}/contents`,
      body: { title: '  Pão de queijo  ', format: 'reels', publishOn: '2026-10-22', publishAtTime: '09:15', caption: 'Quentinho', folderId: VIDEOS, mediaAssetIds: [VID_1.id] }
    }]);
    expect(await screen.findAllByRole('link', { name: /Pão de queijo/ })).toBeTruthy();
  });

  it('asks for the folder before sending anything', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Sem pasta');
    click('Criar conteúdo');
    expect(await within(dialog()).findByText('Escolha a pasta.')).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it.each([
    ['a refused title', () => invalidField('title'), 'O título não foi aceito. Revise o texto.'],
    ['an archived client', () => failure(409, 'CLIENT_ARCHIVED'), 'Este cliente está arquivado: o conteúdo é só leitura.'],
    ['a client that is gone', () => failure(404, 'NOT_FOUND'), 'Este cliente não existe mais.'],
    ['a lost race', () => failure(409, 'TRY_AGAIN'), 'Outra alteração aconteceu ao mesmo tempo. Salve de novo.']
  ])('answers %s with its own words, keeps the modal open and what was typed', async (_name, answer, text) => {
    const { impl } = makeFetch({ override: (call) => (call.method === 'POST' ? answer() : undefined) });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Título', 'Pão novo');
    type('Pasta', IMAGES);
    await readyToCreate();
    click('Criar conteúdo');

    expect((await within(dialog()).findAllByText(text)).length).toBeGreaterThan(0);
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect((field('Título') as HTMLInputElement).value).toBe('Pão novo');
    expect((field('Pasta') as HTMLSelectElement).value).toBe(IMAGES);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('creates once, with the media swapped by hand after the folder was read, in the one request', async () => {
    const { impl, calls, contents } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Título', 'Pão novo');
    type('Pasta', IMAGES);
    await readyToCreate();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    click('Criar conteúdo');
    await waitFor(closed);

    expect(writes(calls).map((call) => call.method)).toEqual(['POST']);
    expect(contents).toHaveLength(1);
    expect(contents[0]!.media).toEqual([IMG_2.id]);
    expect(writes(calls)[0]!.body).toMatchObject({ folderId: IMAGES, mediaAssetIds: [IMG_2.id] });
  });

  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], 'Você não tem permissão para criar conteúdos.'],
  ])('shows no form to who cannot create (%s)', async (_name, permissions, text) => {
    const { impl } = makeFetch({ permissions });
    render_(impl, `${base()}/novo`);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('shows no form on an archived client, and says why', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base(barbearia.id)}/novo`);
    expect(await screen.findByText('Este cliente está arquivado: não recebe conteúdo novo.')).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('does not show a form before it knows who the client is', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({
      override: (call) => (call.method === 'GET' && call.path === `/agencies/${AGENCY}/clients/${padaria.id}` ? held.then(() => undefined) as never : undefined)
    });
    render_(impl, `${base()}/novo`);
    await screen.findByRole('dialog', { name: 'Novo conteúdo' });
    expect(screen.queryByText('Você não tem permissão para criar conteúdos.')).toBeNull();
    expect(screen.queryByLabelText('Título')).toBeNull();
    release();
    expect(await screen.findByLabelText('Título')).toBeTruthy();
  });
});

describe('the conversation of the content (#266)', () => {
  const LATE = '2026-10-13T01:30:00.000Z';
  const IN_PRODUCTION = 'A conversa só aceita mensagens a partir de "Aguardando aprovação"; este conteúdo ainda está em produção.';
  const CANCELLED = 'Este conteúdo foi cancelado: a conversa não recebe mais mensagens.';
  const NOT_OPEN = 'A conversa só aceita mensagens a partir de "Aguardando aprovação". Este conteúdo está em produção ou foi cancelado.';
  const awaiting = (overrides: Partial<Stored> = {}): Stored => stored({ status: 'awaiting_approval', ...overrides });
  const withThread = (row: Stored, comments: ReadonlyArray<{ side: 'agency' | 'client'; body: string; at: string }>): Scenario['seedConversation'] =>
    (conversation) => { conversation.seed({ contentId: row.id }, comments); };
  const conversationOf = async (row: Stored): Promise<HTMLElement> => await screen.findByRole('region', { name: `Conversa sobre ${row.title}` });
  const threadDialog = async (row: Stored): Promise<HTMLElement> => await screen.findByRole('dialog', { name: `Conversa sobre ${row.title}` });
  const openThread = async (row: Stored, excerpt: RegExp | string): Promise<HTMLElement> => {
    fireEvent.click(await within(await conversationOf(row)).findByRole('button', { name: excerpt }));
    return await threadDialog(row);
  };

  it('sits at the end of the Geral tab, after the form and outside it', async () => {
    const row = awaiting();
    await openContent(row);
    const region = await conversationOf(row);
    const form = dialog().querySelector('form.content-modal__form')!;
    expect(form.contains(region)).toBe(false);
    expect(region.closest('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(within(dialog()).getByRole('tab', { name: 'Geral' }).id);
    expect(form.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(region).getByRole('heading', { name: 'Conversa' })).toBeTruthy();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');
  });

  it('is not there while the content is not created yet', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    expect(screen.queryByRole('region', { name: /Conversa/ })).toBeNull();
  });

  it('shows the thread of this content only, with the side and the day in São Paulo, and no id on the screen', async () => {
    const row = awaiting();
    const other = awaiting({ title: 'Outro conteúdo' });
    await openContent(row, {
      contents: [other],
      seedConversation: (conversation) => {
        conversation.seed({ contentId: other.id }, [{ side: 'client', body: 'Mensagem do outro conteúdo', at: LATE }]);
        conversation.seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]);
      }
    });
    const region = await conversationOf(row);
    await within(region).findByText('Gostei, mas troquem a foto');
    expect(within(region).queryByText('Mensagem do outro conteúdo')).toBeNull();
    const thread = await openThread(row, /Gostei, mas troquem a foto/);
    await within(thread).findByText('Gostei, mas troquem a foto');
    expect(Array.from(thread.querySelectorAll('.conversation__comment-meta')).map((meta) => meta.textContent)).toEqual(['Maria · cliente · 12/10 22:30']);
    expect(region.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(thread.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('starts the conversation of the content, writes it as the content\'s, and reads the calendar again', async () => {
    const row = awaiting();
    const { calls } = await openContent(row);
    const region = await conversationOf(row);
    await calendarReady();
    const before = periodCalls(calls).length;

    fireEvent.click(await within(region).findByRole('button', { name: `Nova conversa sobre ${row.title}` }));
    const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
    fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos usar outra foto?' } });
    fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));

    await within(region).findByText('Podemos usar outra foto?');
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agencies/${AGENCY}/clients/${padaria.id}/threads`, body: { subject: { contentId: row.id }, body: 'Podemos usar outra foto?' } }]);
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: `Nova conversa sobre ${row.title}` })).toBeNull();
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
  });

  it('answers a thread without saving the content or closing its modal', async () => {
    const row = awaiting();
    const { calls, probe } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
    const thread = await openThread(row, /Gostei, mas troquem a foto/);

    fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Trocamos hoje' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    await within(thread).findByText('Trocamos hoje');
    // A submit that also reached the form of the content would save it and close the modal a moment later.
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(probe.pathname).toBe(`${base()}/${row.id}`);

    expect(writes(calls).map((call) => `${call.method} ${call.path.replace(/threads\/[^/]+/, 'threads/:id')}`)).toEqual([
      `POST /agencies/${AGENCY}/clients/${padaria.id}/threads/:id/comments`
    ]);
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
    expect((within(screen.getByRole('dialog', { name: row.title })).getByLabelText('Título') as HTMLInputElement).value).toBe(row.title);
  });

  it('keeps what was typed when the answer is refused, and clears it when it goes through', async () => {
    const row = awaiting();
    const { conversation } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
    const thread = await openThread(row, /Gostei, mas troquem a foto/);
    const box = (): HTMLTextAreaElement => within(thread).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement;

    conversation.failNextWrite(() => failure(500, 'INTERNAL_ERROR'));
    fireEvent.change(box(), { target: { value: 'Trocamos hoje' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    await within(thread).findByText('Não foi possível enviar. Tente de novo.');
    expect(box().value).toBe('Trocamos hoje');

    fireEvent.click(within(thread).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(box().value).toBe(''));
    await within(thread).findByText('Trocamos hoje');
  });

  it('refuses a text the rule refuses, in the screen\'s words, and sends nothing', async () => {
    const row = awaiting();
    const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
    const thread = await openThread(row, /Gostei/);
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'texto ‮oculto' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    expect(within(thread).getByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('shows what a client wrote as text, even when it looks like markup', async () => {
    const row = awaiting();
    const hostile = '<script>window.__hacked = 1</script><img src="x" onerror="window.__hacked = 2">';
    await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: hostile, at: LATE }]) });
    const thread = await openThread(row, /script/);
    await within(thread).findByText(hostile);
    expect(thread.querySelector('script, img')).toBeNull();
    expect(screen.getByRole('dialog', { name: row.title }).querySelector('.content-modal__conversation script, .content-modal__conversation img')).toBeNull();
    expect((window as unknown as { __hacked?: number }).__hacked).toBeUndefined();
  });

  describe('who may write', () => {
    it('reads and nothing else with only conteudo.visualizar: no composer, no Resolver, no new conversation', async () => {
      const row = awaiting();
      const empty = awaiting({ title: 'Sem conversa' });
      const { calls } = await openContent(row, {
        permissions: [VISUALIZE, READ_CLIENTS],
        contents: [empty],
        seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }])
      });
      const region = await conversationOf(row);
      expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      await within(thread).findByText('Gostei, mas troquem a foto');
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Resolver' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });

    it('offers no way to start a conversation with only conteudo.visualizar', async () => {
      const row = awaiting();
      await openContent(row, { permissions: [VISUALIZE, READ_CLIENTS] });
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).queryByRole('button')).toBeNull();
    });

    it('resolves with conteudo.operar and conteudo.visualizar, and the thread reads as resolved', async () => {
      const row = awaiting();
      const other = awaiting({ title: 'Outro conteúdo' });
      const ids: { mine?: string; other?: string } = {};
      const { calls, conversation } = await openContent(row, {
        contents: [other],
        seedConversation: (fake) => {
          ids.other = fake.seed({ contentId: other.id }, [{ side: 'client', body: 'Mensagem do outro conteúdo', at: LATE }]);
          ids.mine = fake.seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]);
        }
      });
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      fireEvent.click(within(thread).getByRole('button', { name: 'Resolver' }));
      await within(thread).findByText(/Resolvida por Ana em /);
      expect(writes(calls).map((call) => call.path)).toEqual([`/agencies/${AGENCY}/clients/${padaria.id}/threads/${ids.mine}/resolve`]);
      expect(conversation.threads.find((candidate) => candidate.id === ids.other)?.resolvedAt).toBeNull();
    });

    it('is read-only on an archived client', async () => {
      const row = awaiting({ clientId: barbearia.id });
      const { impl, calls } = makeFetch({
        contents: [row],
        seedConversation: (_padaria, forClient) => { forClient(barbearia.id).seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei', at: LATE }]); }
      });
      render_(impl, `${base(barbearia.id)}/${row.id}`);
      await screen.findByLabelText('Título');
      const thread = await openThread(row, /Gostei/);
      await within(thread).findByText('Gostei');
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Resolver' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });
  });

  describe('where the agency writes: every state of the content, written by hand', () => {
    // The API takes a message in every state but production and cancelled (decision 2026-10-11, item 4): "em ajuste" is
    // where the client asked for a change by the conversation and the agency has to answer it.
    const WRITES = ['awaiting_approval', 'adjusting', 'approved', 'published'] as const;
    const REFUSES: ReadonlyArray<readonly ['in_production' | 'cancelled', string]> = [['in_production', IN_PRODUCTION], ['cancelled', CANCELLED]];

    it.each(WRITES)('answers in a %s content: the reply box, Responder and no reason', async (state) => {
      const row = stored({ status: state });
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
      const region = await conversationOf(row);
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(region).queryByText(CANCELLED)).toBeNull();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      expect(within(thread).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).queryByText(CANCELLED)).toBeNull();

      fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Trocamos hoje' } });
      fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
      await within(thread).findByText('Trocamos hoje');
      expect(writes(calls).map((call) => call.path.split('/').pop())).toEqual(['comments']);
    });

    it.each(WRITES)('starts the conversation of a %s content, with no reason', async (state) => {
      const row = stored({ status: state });
      const { calls } = await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(region).queryByText(CANCELLED)).toBeNull();

      fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${row.title}` }));
      const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
      fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos usar outra foto?' } });
      fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));
      await within(region).findByText('Podemos usar outra foto?');
      expect(writes(calls).map((call) => call.path.split('/').pop())).toEqual(['threads']);
    });

    it.each(REFUSES)('refuses in a %s content: the reason, no reply box and no new conversation', async (state, reason) => {
      const row = stored({ status: state });
      const other = stored({ status: state, title: 'Sem conversa' });
      const { calls } = await openContent(row, { contents: [other], seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const region = await conversationOf(row);
      expect(await within(region).findByText(reason)).toBeTruthy();
      const thread = await openThread(row, /Gostei/);
      expect(within(thread).getByText(reason)).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });
  });

  it('shows the conversation of the content that was opened, never the one of the content opened before it while its answer is on its way', async () => {
    const first = awaiting({ title: 'Primeiro conteúdo' });
    const second = awaiting({ title: 'Segundo conteúdo' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { probe } = await openContent(first, {
      contents: [second],
      seedConversation: (conversation) => {
        conversation.seed({ contentId: first.id }, [{ side: 'client', body: 'Mensagem do primeiro', at: LATE }]);
        conversation.seed({ contentId: second.id }, [{ side: 'client', body: 'Mensagem do segundo', at: LATE }]);
      },
      override: (call) => (call.method === 'GET' && call.path.includes('/threads?') && call.path.includes(`contentId=${second.id}`) ? held.then(() => undefined) as never : undefined)
    });
    const region = await conversationOf(first);
    await within(region).findByText('Mensagem do primeiro');

    probe.navigate(`${base()}/${second.id}`);
    const next = await conversationOf(second);
    expect(next.querySelector('.conversation__threads-skeleton')?.getAttribute('aria-busy')).toBe('true');
    expect(next.textContent).not.toContain('Mensagem do primeiro');
    expect(within(next).queryByRole('button', { name: /Mensagem do primeiro/ })).toBeNull();

    release();
    await within(next).findByText('Mensagem do segundo');
    expect(next.textContent).not.toContain('Mensagem do primeiro');
  });

  describe('a content that is not open to the client', () => {
    it.each([
      ['in_production', IN_PRODUCTION],
      ['cancelled', CANCELLED]
    ] as const)('says why nobody writes to a %s content, still reads it and still resolves', async (status, reason) => {
      const row = stored({ status });
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
      const region = await conversationOf(row);
      expect(await within(region).findByText(reason)).toBeTruthy();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      expect(within(thread).getByText(reason)).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      fireEvent.click(within(thread).getByRole('button', { name: 'Resolver' }));
      await within(thread).findByText(/Resolvida por Ana em /);
      expect(writes(calls)).toHaveLength(1);
    });

    it.each([
      ['in_production', IN_PRODUCTION],
      ['cancelled', CANCELLED]
    ] as const)('offers no new conversation on a %s content, and says why', async (status, reason) => {
      const row = stored({ status });
      await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).getByText(reason)).toBeTruthy();
      expect(within(region).queryByRole('button')).toBeNull();
    });

    it('does not tell who only reads that the content is in production: that person reads "somente leitura"', async () => {
      const row = stored({ status: 'in_production' });
      await openContent(row, { permissions: [VISUALIZE, READ_CLIENTS], seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const region = await conversationOf(row);
      const thread = await openThread(row, /Gostei/);
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    });

    it('says it with the words of the screen when the API refuses a message the screen thought was open, and keeps the text', async () => {
      const row = awaiting();
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const thread = await openThread(row, /Gostei/);
      // Another operator sent it back to production after this screen opened.
      row.status = 'in_production';
      await calendarReady();
      const before = periodCalls(calls).length;

      fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Texto que não pode sumir' } });
      fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
      await within(thread).findByText(NOT_OPEN);
      expect((within(thread).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
      expect(writes(calls).map((call) => call.method)).toEqual(['POST']);
      await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
      expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
    });

    it('says it too when the API refuses to open the conversation', async () => {
      const row = awaiting();
      await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      row.status = 'in_production';
      fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${row.title}` }));
      const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
      fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Texto que não pode sumir' } });
      fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));
      await within(opening).findByText(NOT_OPEN);
      expect((within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
    });
  });

  it('closes only the conversation with Esc, and the content stays open', async () => {
    const row = awaiting();
    await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
    const thread = await openThread(row, /Gostei/);
    fireEvent(thread, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Conversa sobre ${row.title}` })).toBeNull());
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
  });
});
