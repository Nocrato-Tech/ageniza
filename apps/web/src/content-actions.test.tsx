// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AGENCY,
  barbearia,
  base,
  contentPath,
  dialog,
  failure,
  IMAGES,
  IMG_1,
  json,
  openContent,
  padaria,
  periodCalls,
  READ_CLIENTS,
  render_,
  makeFetch,
  setupModalTests,
  stored,
  type,
  VIDEOS,
  VID_1,
  VISUALIZE,
  writes,
  type Call,
  type Stored
} from './content-modal-fixture.js';

setupModalTests();

const OPERATE = 'conteudo.operar';
const APPROVE = 'conteudo.aprovar_pela_agencia';
const PUBLISH = 'conteudo.publicar';
const CANCEL = 'conteudo.cancelar';

const ACTION_LABELS = ['Enviar para aprovação', 'Aprovar pela agência', 'Marcar como publicado', 'Desfazer publicação', 'Reagendar', 'Cancelar conteúdo'] as const;
const SUBMIT = 'Enviar para aprovação';

/** A role with one permission of the moves: the menu and the guard answer to that one only. */
const only = (permission: string): string[] => [VISUALIZE, READ_CLIENTS, permission];

const shown = (): string[] => ACTION_LABELS.filter((label) => within(dialog()).queryByRole('button', { name: label }) !== null);

/** Waits until the client was read: before that the modal cannot know the state of the client, and shows no move. */
const settled = async (calls: readonly Call[]): Promise<void> => {
  await waitFor(() => expect(calls.some((call) => call.path === `/agencies/${AGENCY}/clients/${padaria.id}`)).toBe(true));
  await new Promise((resolve) => { setTimeout(resolve, 60); });
};

const moves = (calls: readonly Call[]): Call[] => writes(calls).filter((call) => call.method === 'POST');
const complete = (overrides: Partial<Stored> = {}): Stored => stored({ format: 'image', folderId: IMAGES, media: [IMG_1.id], ...overrides });
const clickMove = (label: string): void => { fireEvent.click(within(dialog()).getByRole('button', { name: label })); };
const status = (contents: readonly Stored[], id: string) => contents.find((content) => content.id === id)!.status;

describe('which button shows: the state AND the permission', () => {
  // Written by hand, value by value: the table is not derived from the rule it checks.
  it.each([
    ['in_production', OPERATE, [SUBMIT]],
    ['in_production', APPROVE, []],
    ['in_production', PUBLISH, []],
    ['in_production', CANCEL, ['Cancelar conteúdo']],
    ['awaiting_approval', OPERATE, []],
    ['awaiting_approval', APPROVE, ['Aprovar pela agência']],
    ['awaiting_approval', PUBLISH, []],
    ['awaiting_approval', CANCEL, ['Cancelar conteúdo']],
    ['adjusting', OPERATE, [SUBMIT]],
    ['adjusting', APPROVE, []],
    ['adjusting', PUBLISH, []],
    ['adjusting', CANCEL, ['Cancelar conteúdo']],
    ['approved', OPERATE, []],
    ['approved', APPROVE, []],
    ['approved', PUBLISH, ['Marcar como publicado']],
    ['approved', CANCEL, ['Cancelar conteúdo']],
    ['published', OPERATE, []],
    ['published', APPROVE, []],
    ['published', PUBLISH, ['Desfazer publicação']],
    ['published', CANCEL, []],
    ['cancelled', OPERATE, ['Reagendar']],
    ['cancelled', APPROVE, []],
    ['cancelled', PUBLISH, []],
    ['cancelled', CANCEL, []]
  ] as const)('a %s content, for a role with only %s, shows %j', async (state, permission, expected) => {
    const { calls } = await openContent(stored({ status: state }), { permissions: only(permission) });
    await settled(calls);
    expect(shown()).toEqual(expected);
  });

  it.each(['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled'] as const)(
    'a %s content shows no move at all to who only reads',
    async (state) => {
      const { calls } = await openContent(stored({ status: state }), { permissions: [VISUALIZE, READ_CLIENTS] });
      await settled(calls);
      expect(shown()).toEqual([]);
      expect(within(dialog()).queryByRole('region', { name: 'Ações do conteúdo' })).toBeNull();
    }
  );

  it('shows every move its state allows to a role that holds all four permissions', async () => {
    const { calls } = await openContent(stored({ status: 'approved' }), { permissions: [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE, PUBLISH, CANCEL] });
    await settled(calls);
    expect(shown()).toEqual(['Marcar como publicado', 'Cancelar conteúdo']);
  });

  it('shows no move on an archived client, whatever the state and the permissions', async () => {
    const row = stored({ clientId: barbearia.id, status: 'approved' });
    const { impl, calls } = makeFetch({ contents: [row], permissions: [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE, PUBLISH, CANCEL] });
    render_(impl, `${base(barbearia.id)}/${row.id}`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(calls.some((call) => call.path === `/agencies/${AGENCY}/clients/${barbearia.id}`)).toBe(true));
    await within(dialog()).findByText('Cliente arquivado: o conteúdo é só leitura.');
    expect(shown()).toEqual([]);
  });

  it('keeps the moves out of a content that is being created', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE, PUBLISH, CANCEL] });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    expect(shown()).toEqual([]);
  });

  it('waits while the form has changes that were not saved, and says why', async () => {
    const { calls } = await openContent(complete({ status: 'in_production' }), { permissions: [VISUALIZE, READ_CLIENTS, OPERATE] });
    await settled(calls);
    const submit = within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(within(dialog()).queryByText('Salve as mudanças antes de usar estas ações.')).toBeNull();
    type('Título', 'Mudei e não salvei');
    expect(submit.disabled).toBe(true);
    expect(within(dialog()).getByText('Salve as mudanças antes de usar estas ações.')).toBeTruthy();
    type('Título', 'Lançamento do pão');
    expect(submit.disabled).toBe(false);
  });
});

describe('Enviar para aprovação', () => {
  const EDITOR = [VISUALIZE, READ_CLIENTS, OPERATE];

  it('sends the content with no body, closes, reads the calendar again, and the state is the API\'s', async () => {
    const row = complete();
    const { calls, contents } = await openContent(row, { permissions: EDITOR });
    const before = periodCalls(calls).length;
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    clickMove(SUBMIT);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/submit`, body: undefined }]);
    expect(status(contents, row.id)).toBe('awaiting_approval');
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
  });

  it('acts on the content that was opened, not on another one of the calendar', async () => {
    const first = complete({ title: 'Primeiro' });
    const second = complete({ title: 'Segundo' });
    const { impl, calls, contents } = makeFetch({ permissions: EDITOR, contents: [first, second] });
    render_(impl, `${base()}/${second.id}`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    clickMove(SUBMIT);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls).map((call) => call.path)).toEqual([`${contentPath(second.id)}/submit`]);
    expect(status(contents, first.id)).toBe('in_production');
    expect(status(contents, second.id)).toBe('awaiting_approval');
  });

  it('sends once when it is clicked twice, and does not close while the answer is on its way', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const row = complete();
    const { calls } = await openContent(row, {
      permissions: EDITOR,
      override: (call) => (call.path.endsWith('/submit') ? held.then(() => undefined) as never : undefined)
    });
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    clickMove(SUBMIT);
    clickMove(SUBMIT);
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar conteúdo' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toHaveLength(1);
  });

  const BAD_ASSET = 'a0a0a0a0-0000-4000-8000-000000000999';
  const missingRows: ReadonlyArray<readonly [string, Partial<Stored>, string[]]> = [
    ['an image with no media', { format: 'image', folderId: IMAGES, media: [] }, ['Falta a imagem do post.']],
    ['a video with no media', { format: 'reels', folderId: VIDEOS, media: [] }, ['Falta o vídeo do post.']],
    ['a carousel with no media', { format: 'carousel', folderId: IMAGES, media: [] }, ['Faltam as mídias do carrossel: ele leva de 2 a 20.']],
    ['a carousel with one media', { format: 'carousel', folderId: IMAGES, media: [IMG_1.id] }, ['Falta pelo menos mais 1 mídia: um carrossel leva de 2 a 20.']],
    ['an image format holding a video', { format: 'image', folderId: VIDEOS, media: [VID_1.id] }, ['A mídia escolhida é um vídeo e este formato leva uma imagem.']],
    ['a video format holding an image', { format: 'reels', folderId: IMAGES, media: [IMG_1.id] }, ['A mídia escolhida é uma imagem e este formato leva um vídeo.']],
    ['a media that is not confirmed or left the folder', { format: 'image', folderId: IMAGES, media: [BAD_ASSET] }, ['Há mídia que ainda não terminou de subir ou que saiu da pasta.']],
    ['a cover that left the folder', { format: 'reels', folderId: VIDEOS, media: [VID_1.id], coverAssetId: BAD_ASSET }, ['A capa saiu da pasta ou ainda não terminou de subir.']],
    ['one subtask not approved', { format: 'image', folderId: IMAGES, media: [IMG_1.id], tasks: ['approved', 'pending'] }, ['Falta aprovar 1 subtarefa.']],
    ['two subtasks not approved', { format: 'image', folderId: IMAGES, media: [IMG_1.id], tasks: ['pending', 'delivered', 'approved'] }, ['Faltam aprovar 2 subtarefas.']]
  ];

  it.each(missingRows)('shows what is missing before it is sent, and holds the button: %s', async (_name, overrides, lines) => {
    const { calls } = await openContent(stored(overrides), { permissions: EDITOR });
    await settled(calls);
    const list = await within(dialog()).findByRole('status');
    expect(within(list).getByText('Antes de enviar para aprovação, falta:')).toBeTruthy();
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(lines);
    expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(true);
    expect(moves(calls)).toHaveLength(0);
  });

  it('lists everything that is missing, one line each', async () => {
    const { calls } = await openContent(stored({ format: 'carousel', folderId: IMAGES, media: [IMG_1.id], tasks: ['pending'] }), { permissions: EDITOR });
    await settled(calls);
    const list = await within(dialog()).findByRole('status');
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Falta pelo menos mais 1 mídia: um carrossel leva de 2 a 20.',
      'Falta aprovar 1 subtarefa.'
    ]);
  });

  it('shows no list and holds nothing for a content that is complete, with approved subtasks', async () => {
    const { calls } = await openContent(complete({ tasks: ['approved', 'approved'] }), { permissions: EDITOR });
    await settled(calls);
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(dialog()).queryByRole('status')).toBeNull();
  });

  it('does not tell what is missing to who cannot send, and the list is for the states where a send exists', async () => {
    const { calls } = await openContent(stored({ status: 'awaiting_approval', media: [] }), { permissions: [VISUALIZE, READ_CLIENTS, APPROVE] });
    await settled(calls);
    expect(within(dialog()).queryByText('Antes de enviar para aprovação, falta:')).toBeNull();
  });

  it('does not block the send when the media of the folder could not be read, and the API has the last word', async () => {
    const { calls } = await openContent(complete(), {
      permissions: EDITOR,
      override: (call) => (/\/assets\?/.test(call.path) ? failure(500, 'INTERNAL') : undefined)
    });
    await settled(calls);
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    expect(within(dialog()).queryByRole('status')).toBeNull();
  });

  it('says in its own words that a media is still uploading, and keeps the modal open', async () => {
    const { calls } = await openContent(complete(), {
      permissions: EDITOR,
      override: (call) => (call.path.endsWith('/submit') ? failure(409, 'CONTENT_MEDIA_NOT_CONFIRMED') : undefined)
    });
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    clickMove(SUBMIT);
    expect(await within(dialog()).findByText('O conteúdo tem mídia que ainda não terminou de subir. Espere o envio terminar ou troque a mídia.')).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(moves(calls)).toHaveLength(1);
  });
});

describe('Aprovar pela agência', () => {
  const APPROVER = [VISUALIZE, READ_CLIENTS, APPROVE];
  const waiting = (): Stored => stored({ status: 'awaiting_approval', revision: 3 });

  it('asks for the reason first, and sends the revision that was read with it', async () => {
    const row = waiting();
    const { calls, contents } = await openContent(row, { permissions: APPROVER });
    await settled(calls);
    clickMove('Aprovar pela agência');
    expect(moves(calls)).toHaveLength(0);
    fireEvent.change(within(dialog()).getByLabelText('Motivo da aprovação'), { target: { value: 'O cliente aprovou por telefone' } });
    clickMove('Confirmar aprovação');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/approve-by-agency`, body: { revision: 3, reason: 'O cliente aprovou por telefone' } }]);
    expect(status(contents, row.id)).toBe('approved');
  });

  it.each([
    ['no reason', '', 'Informe o motivo da aprovação.'],
    ['a reason of blanks', '   \n ', 'Informe o motivo da aprovação.'],
    ['a reason with an invisible character', 'ok​ok', 'O motivo tem caracteres que não são aceitos, ou passa de 5000 bytes.'],
    ['a reason of 5.001 bytes', 'a'.repeat(5001), 'O motivo tem caracteres que não são aceitos, ou passa de 5000 bytes.']
  ])('sends nothing with %s, and says why', async (_name, reason, text) => {
    const { calls } = await openContent(waiting(), { permissions: APPROVER });
    await settled(calls);
    clickMove('Aprovar pela agência');
    fireEvent.change(within(dialog()).getByLabelText('Motivo da aprovação'), { target: { value: reason } });
    clickMove('Confirmar aprovação');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(within(dialog()).getByLabelText('Motivo da aprovação').getAttribute('aria-invalid')).toBe('true');
    expect(moves(calls)).toHaveLength(0);
  });

  it('accepts a reason of exactly 5.000 bytes', async () => {
    const { calls } = await openContent(waiting(), { permissions: APPROVER });
    await settled(calls);
    clickMove('Aprovar pela agência');
    fireEvent.change(within(dialog()).getByLabelText('Motivo da aprovação'), { target: { value: 'a'.repeat(5000) } });
    clickMove('Confirmar aprovação');
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
  });

  it('keeps the reason and the modal when the content changed in the meantime, in its own words', async () => {
    const { calls } = await openContent(waiting(), {
      permissions: APPROVER,
      override: (call) => (call.path.endsWith('/approve-by-agency') ? failure(409, 'CONTENT_REVISION_CHANGED') : undefined)
    });
    await settled(calls);
    clickMove('Aprovar pela agência');
    fireEvent.change(within(dialog()).getByLabelText('Motivo da aprovação'), { target: { value: 'Motivo digitado' } });
    clickMove('Confirmar aprovação');
    expect(await within(dialog()).findByText('O conteúdo mudou desde que você o abriu. Feche, abra de novo e confira antes de aprovar.')).toBeTruthy();
    expect((within(dialog()).getByLabelText('Motivo da aprovação') as HTMLTextAreaElement).value).toBe('Motivo digitado');
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('closes the panel when the button is pressed again', async () => {
    const { calls } = await openContent(waiting(), { permissions: APPROVER });
    await settled(calls);
    clickMove('Aprovar pela agência');
    expect(within(dialog()).queryByLabelText('Motivo da aprovação')).not.toBeNull();
    clickMove('Aprovar pela agência');
    expect(within(dialog()).queryByLabelText('Motivo da aprovação')).toBeNull();
  });
});

describe('Marcar como publicado e Desfazer publicação', () => {
  const PUBLISHER = [VISUALIZE, READ_CLIENTS, PUBLISH];

  it('proposes today in São Paulo as the real day, and sends the day that is chosen', async () => {
    const row = stored({ status: 'approved' });
    const { calls, contents } = await openContent(row, { permissions: PUBLISHER });
    await settled(calls);
    clickMove('Marcar como publicado');
    const day = within(dialog()).getByLabelText('Dia real da publicação') as HTMLInputElement;
    expect(day.value).toBe('2026-10-11');
    expect(day.max).toBe('2026-10-11');
    clickMove('Confirmar publicação');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/publish`, body: { publishedOn: '2026-10-11' } }]);
    expect(status(contents, row.id)).toBe('published');
  });

  it('sends an earlier day as it was chosen', async () => {
    const { calls } = await openContent(stored({ status: 'approved' }), { permissions: PUBLISHER });
    await settled(calls);
    clickMove('Marcar como publicado');
    fireEvent.change(within(dialog()).getByLabelText('Dia real da publicação'), { target: { value: '2026-10-09' } });
    clickMove('Confirmar publicação');
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]!.body).toEqual({ publishedOn: '2026-10-09' });
  });

  it.each([
    ['a future day', '2026-10-12'],
    ['no day', '']
  ])('sends nothing for %s, and says why', async (_name, value) => {
    const { calls } = await openContent(stored({ status: 'approved' }), { permissions: PUBLISHER });
    await settled(calls);
    clickMove('Marcar como publicado');
    fireEvent.change(within(dialog()).getByLabelText('Dia real da publicação'), { target: { value } });
    clickMove('Confirmar publicação');
    expect(await within(dialog()).findByText('Informe o dia real da publicação, que não pode ser futuro.')).toBeTruthy();
    expect(moves(calls)).toHaveLength(0);
  });

  it('says in its own words that the API refused the day', async () => {
    const { calls } = await openContent(stored({ status: 'approved' }), {
      permissions: PUBLISHER,
      override: (call) => (call.path.endsWith('/publish') ? failure(400, 'CONTENT_PUBLISHED_ON_INVALID') : undefined)
    });
    await settled(calls);
    clickMove('Marcar como publicado');
    clickMove('Confirmar publicação');
    expect(await within(dialog()).findByText('A data real da publicação não pode ser futura.')).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
  });

  it('undoes the publication with no body, and the state is the API\'s', async () => {
    const row = stored({ status: 'published', publishedOn: '2026-10-11' });
    const { calls, contents } = await openContent(row, { permissions: PUBLISHER });
    await settled(calls);
    clickMove('Desfazer publicação');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/unpublish`, body: undefined }]);
    expect(status(contents, row.id)).toBe('approved');
  });

  it('says in its own words that the day to undo has passed', async () => {
    const { calls } = await openContent(stored({ status: 'published' }), {
      permissions: PUBLISHER,
      override: (call) => (call.path.endsWith('/unpublish') ? failure(409, 'CONTENT_UNPUBLISH_EXPIRED') : undefined)
    });
    await settled(calls);
    clickMove('Desfazer publicação');
    expect(await within(dialog()).findByText('A publicação só se desfaz no dia em que foi marcada.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

describe('Cancelar conteúdo e Reagendar', () => {
  it('cancels with no body, closes, and the state is the API\'s', async () => {
    const row = stored({ status: 'approved' });
    const { calls, contents } = await openContent(row, { permissions: only(CANCEL) });
    await settled(calls);
    clickMove('Cancelar conteúdo');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/cancel`, body: undefined }]);
    expect(status(contents, row.id)).toBe('cancelled');
  });

  it('does not mix the button that cancels the content with the one that closes the modal', async () => {
    const { calls } = await openContent(stored({ status: 'in_production' }), { permissions: only(CANCEL) });
    await settled(calls);
    expect(within(dialog()).getAllByRole('button', { name: 'Fechar' })).toHaveLength(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toHaveLength(0);
  });

  it('reschedules on the day it had, or on the day that is chosen', async () => {
    const row = stored({ status: 'cancelled', publishOn: '2026-10-20' });
    const { calls, contents } = await openContent(row, { permissions: only(OPERATE) });
    await settled(calls);
    clickMove('Reagendar');
    const day = within(dialog()).getByLabelText('Novo dia da publicação') as HTMLInputElement;
    expect(day.value).toBe('2026-10-20');
    fireEvent.change(day, { target: { value: '2026-10-28' } });
    clickMove('Confirmar novo dia');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(moves(calls)).toEqual([{ method: 'POST', path: `${contentPath(row.id)}/reschedule`, body: { publishOn: '2026-10-28' } }]);
    expect(status(contents, row.id)).toBe('in_production');
    expect(contents.find((content) => content.id === row.id)!.publishOn).toBe('2026-10-28');
  });

  it('sends nothing without a day to reschedule, and says why', async () => {
    const { calls } = await openContent(stored({ status: 'cancelled' }), { permissions: only(OPERATE) });
    await settled(calls);
    clickMove('Reagendar');
    fireEvent.change(within(dialog()).getByLabelText('Novo dia da publicação'), { target: { value: '' } });
    clickMove('Confirmar novo dia');
    expect(await within(dialog()).findByText('Informe o novo dia da publicação.')).toBeTruthy();
    expect(moves(calls)).toHaveLength(0);
  });
});

describe('what the API refuses', () => {
  const ALL = [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE, PUBLISH, CANCEL];
  const STATE_TEXT: Readonly<Record<string, string>> = {
    submit: 'Só um conteúdo em produção ou em ajuste é enviado para aprovação. Feche e abra de novo para ver o estado atual.',
    cancel: 'Um conteúdo publicado não é cancelado. Feche e abra de novo para ver o estado atual.',
    unpublish: 'Só um conteúdo publicado volta a pronto para publicar. Feche e abra de novo para ver o estado atual.',
    publish: 'Só um conteúdo pronto para publicar é marcado como publicado. Feche e abra de novo para ver o estado atual.',
    reschedule: 'Só um conteúdo cancelado é reagendado. Feche e abra de novo para ver o estado atual.',
    'approve-by-agency': 'Só um conteúdo aguardando aprovação é aprovado. Feche e abra de novo para ver o estado atual.'
  };

  const flows: ReadonlyArray<readonly [string, string, Partial<Stored>, () => void]> = [
    ['submit', 'submit', complete(), () => clickMove(SUBMIT)],
    ['cancel', 'cancel', { status: 'approved' }, () => clickMove('Cancelar conteúdo')],
    ['unpublish', 'unpublish', { status: 'published' }, () => clickMove('Desfazer publicação')],
    ['publish', 'publish', { status: 'approved' }, () => { clickMove('Marcar como publicado'); clickMove('Confirmar publicação'); }],
    ['reschedule', 'reschedule', { status: 'cancelled' }, () => { clickMove('Reagendar'); clickMove('Confirmar novo dia'); }],
    ['approve-by-agency', 'approve', { status: 'awaiting_approval' }, () => {
      clickMove('Aprovar pela agência');
      fireEvent.change(within(dialog()).getByLabelText('Motivo da aprovação'), { target: { value: 'Por telefone' } });
      clickMove('Confirmar aprovação');
    }]
  ];

  it.each(flows)('a lost state on %s (409 CONTENT_STATE) has the words of that move', async (segment, _name, overrides, act) => {
    const { calls } = await openContent(stored({ ...overrides, ...(segment === 'submit' ? { format: 'image', folderId: IMAGES, media: [IMG_1.id] } : {}) }), {
      permissions: ALL,
      override: (call) => (call.path.endsWith(`/${segment}`) ? failure(409, 'CONTENT_STATE') : undefined)
    });
    await settled(calls);
    await waitFor(() => expect(within(dialog()).getAllByRole('button', { name: /^(Enviar|Cancelar conteúdo|Desfazer|Marcar|Reagendar|Aprovar)/ }).some((button) => !(button as HTMLButtonElement).disabled)).toBe(true));
    act();
    expect(await within(dialog()).findByText(STATE_TEXT[segment]!)).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o conteúdo é só leitura.'],
    [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.'],
    [409, 'CONTENT_TASKS_NOT_APPROVED', 'Todas as subtarefas precisam estar aprovadas antes do envio.'],
    [409, 'CONTENT_MEDIA_INCOMPLETE', 'A mídia ou a capa não está completa para este formato: falta mídia, ou a mídia ou a capa saiu da pasta.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'],
    [404, 'NOT_FOUND', 'Este conteúdo não existe mais.'],
    [500, 'INTERNAL', 'Não foi possível cancelar o conteúdo. Tente de novo.']
  ])('answers %s %s with its own words, keeps the modal open, and reads the calendar again', async (statusCode, code, text) => {
    const { calls } = await openContent(stored({ status: 'approved' }), {
      permissions: ALL,
      override: (call) => (call.path.endsWith('/cancel') ? failure(statusCode, code) : undefined)
    });
    await settled(calls);
    const before = periodCalls(calls).length;
    clickMove('Cancelar conteúdo');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
  });

  it('uses the one text of the move for a failure it does not know, per move', async () => {
    const { calls } = await openContent(complete(), {
      permissions: ALL,
      override: (call) => (call.path.endsWith('/submit') ? json({ error: { code: 'ODD', message: 'MENSAGEM DO SERVIDOR' } }, 418) : undefined)
    });
    await settled(calls);
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: SUBMIT }) as HTMLButtonElement).disabled).toBe(false));
    clickMove(SUBMIT);
    expect(await within(dialog()).findByText('Não foi possível enviar o conteúdo para aprovação. Tente de novo.')).toBeTruthy();
  });

  it('is ready for the next try after a refusal: the button works again', async () => {
    let refusing = true;
    const row = stored({ status: 'approved' });
    const { calls, contents } = await openContent(row, {
      permissions: ALL,
      override: (call) => (refusing && call.path.endsWith('/cancel') ? failure(409, 'TRY_AGAIN') : undefined)
    });
    await settled(calls);
    clickMove('Cancelar conteúdo');
    await within(dialog()).findByText('Outra alteração aconteceu ao mesmo tempo. Tente de novo.');
    refusing = false;
    clickMove('Cancelar conteúdo');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status(contents, row.id)).toBe('cancelled');
    expect(moves(calls)).toHaveLength(2);
  });
});

