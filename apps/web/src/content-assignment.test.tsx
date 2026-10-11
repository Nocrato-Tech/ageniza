// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  barbearia,
  base,
  failure,
  IMAGES,
  IMG_1,
  openContent,
  padaria,
  READ_CLIENTS,
  render_,
  makeFetch,
  setupModalTests,
  stored,
  VISUALIZE,
  writes,
  type Stored
} from './content-modal-fixture.js';
import { ANA, assignmentWorld, BRUNO, CARLA, DIOGO, task, type AssignmentOptions, type WorldTask } from './content-assignment-fixture.js';

setupModalTests();

const OPERATE = 'conteudo.operar';
const APPROVE = 'conteudo.aprovar_pela_agencia';
const TEAM = 'colaborador.visualizar';

/** A role per row, each with the fewest permissions that make the behaviour possible: the screen answers to those and no others. */
const READER = [VISUALIZE, READ_CLIENTS];
const OPERATOR = [VISUALIZE, READ_CLIENTS, OPERATE, TEAM];
const MANAGER = [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE, TEAM];
const APPROVER_ONLY = [VISUALIZE, READ_CLIENTS, APPROVE];

const complete = (overrides: Partial<Stored> = {}): Stored => stored({ status: 'in_production', folderId: IMAGES, media: [IMG_1.id], ...overrides });
const dialogOf = (row: Stored): HTMLElement => screen.getByRole('dialog', { name: row.title });
const click = (row: Stored, name: string | RegExp): void => { fireEvent.click(within(dialogOf(row)).getByRole('button', { name })); };
const posts = (calls: Parameters<typeof writes>[0]) => writes(calls).filter((call) => call.method === 'POST');
const lastSegment = (path: string): string => path.split('?')[0]!.split('/').pop()!;

/** Opens the content and its Atribuição tab. */
const openAssignment = async (row: Stored, options: AssignmentOptions, extra: Parameters<ReturnType<typeof assignmentWorld>['scenario']>[1] = {}) => {
  const { world, scenario } = assignmentWorld(options);
  const opened = await openContent(row, scenario([row], extra));
  await waitFor(() => expect((within(dialogOf(row)).getByRole('tab', { name: 'Atribuição' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(dialogOf(row)).getByRole('tab', { name: 'Atribuição' }));
  await within(dialogOf(row)).findByRole('heading', { name: 'Responsável pelo conteúdo' });
  return { ...opened, world };
};

const panel = (row: Stored): HTMLElement => within(dialogOf(row)).getByRole('tabpanel', { name: 'Atribuição' });
const actionNames = (row: Stored): string[] => within(panel(row)).queryAllByRole('button')
  .map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '')
  .filter((name) => /^(Entregar|Aprovar|Devolver)/.test(name));
const taskItem = (row: Stored, title: string): HTMLElement => {
  const item = within(panel(row)).getByText(title).closest('li');
  if (item === null) throw new Error(`The subtask ${title} was not rendered.`);
  return item;
};
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 60); });

describe('the tab', () => {
  it('opens from the Geral tab, shows its own panel, and gives the form back as it was left', async () => {
    const row = complete();
    const { world, scenario } = assignmentWorld({ permissions: MANAGER, self: ANA.membershipId });
    void world;
    await openContent(row, scenario([row]));
    const form = within(dialogOf(row)).getByLabelText('Título') as HTMLInputElement;
    fireEvent.change(form, { target: { value: 'Título que ainda não foi salvo' } });
    await waitFor(() => expect((within(dialogOf(row)).getByRole('tab', { name: 'Atribuição' }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(within(dialogOf(row)).getByRole('tab', { name: 'Atribuição' }));
    expect(await within(dialogOf(row)).findByRole('heading', { name: 'Responsável pelo conteúdo' })).toBeTruthy();
    expect(within(dialogOf(row)).getByRole('tab', { name: 'Atribuição' }).getAttribute('aria-selected')).toBe('true');
    expect(within(dialogOf(row)).getByRole('tab', { name: 'Geral' }).getAttribute('aria-selected')).toBe('false');
    expect(dialogOf(row).querySelector('[role="tabpanel"][aria-label="Geral"]')?.hasAttribute('hidden')).toBe(true);

    fireEvent.click(within(dialogOf(row)).getByRole('tab', { name: 'Geral' }));
    expect((within(dialogOf(row)).getByLabelText('Título') as HTMLInputElement).value).toBe('Título que ainda não foi salvo');
    expect(within(dialogOf(row)).queryByRole('heading', { name: 'Responsável pelo conteúdo' })).toBeNull();
  });

  it('is not there while a content is being created', async () => {
    const { impl } = makeFetch({ permissions: MANAGER });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    expect((screen.getByRole('tab', { name: 'Atribuição' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what is shown', () => {
  it('shows who is in charge, each subtask with its person, day and state, and the share of approved ones, and no id', async () => {
    const row = complete();
    const tasks = [
      task({ title: 'Roteiro do vídeo', assignee: BRUNO, dueOn: '2026-10-20', status: 'pending' }),
      task({ title: 'Edição', assignee: CARLA, dueOn: '2026-10-22', status: 'delivered' }),
      task({ title: 'Capa', assignee: ANA, dueOn: '2026-10-25', status: 'approved' })
    ];
    await openAssignment(row, { permissions: READER, self: null, owner: ANA, tasks });

    expect(within(panel(row)).getByText('Ana Souza', { selector: 'p' })).toBeTruthy();
    expect(taskItem(row, 'Roteiro do vídeo').textContent).toContain('Responsável: Bruno Lima · Prazo: 20/10/2026 · Pendente');
    expect(taskItem(row, 'Edição').textContent).toContain('Responsável: Carla Dias · Prazo: 22/10/2026 · Entregue');
    expect(taskItem(row, 'Capa').textContent).toContain('Responsável: Ana Souza · Prazo: 25/10/2026 · Aprovada');
    expect(within(panel(row)).getByRole('status').textContent).toBe('1 de 3 aprovadas (33%)');
    expect(panel(row).textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('says there is no one in charge, and shows no percentage over an empty list', async () => {
    const row = complete();
    await openAssignment(row, { permissions: READER, self: null, owner: null, tasks: [] });
    expect(within(panel(row)).getByText('Sem responsável')).toBeTruthy();
    expect(within(panel(row)).getByText('Nenhuma subtarefa ainda.')).toBeTruthy();
    expect(within(panel(row)).queryByRole('status')).toBeNull();
  });

  it('marks as late a subtask whose day is past and is not approved, by the day in São Paulo, and not an approved one', async () => {
    const row = complete();
    const tasks = [
      task({ title: 'Ontem', dueOn: '2026-10-10', status: 'pending' }),
      task({ title: 'Hoje', dueOn: '2026-10-11', status: 'pending' }),
      task({ title: 'Feita ontem', dueOn: '2026-10-10', status: 'approved' })
    ];
    await openAssignment(row, { permissions: READER, self: null, tasks });
    expect(within(taskItem(row, 'Ontem')).getByText('Atrasada')).toBeTruthy();
    expect(within(taskItem(row, 'Hoje')).queryByText('Atrasada')).toBeNull();
    expect(within(taskItem(row, 'Feita ontem')).queryByText('Atrasada')).toBeNull();
  });

  it('shows the comment of a returned subtask, and only while it is pending', async () => {
    const row = complete();
    const tasks = [
      task({ title: 'Devolvida', status: 'pending', returnComment: 'Falta o áudio' }),
      task({ title: 'Reentregue', status: 'delivered', returnComment: 'Texto velho' })
    ];
    await openAssignment(row, { permissions: READER, self: null, tasks });
    expect(within(taskItem(row, 'Devolvida')).getByText('Devolvida: Falta o áudio')).toBeTruthy();
    expect(within(taskItem(row, 'Reentregue')).queryByText(/Devolvida:/)).toBeNull();
  });

  it('shows a name from the server as text, never as markup', async () => {
    const row = complete();
    const tasks = [task({ title: '<img src=x onerror="window.__hacked = 1">', assignee: { membershipId: BRUNO.membershipId, name: '<b>Bruno</b>' } })];
    await openAssignment(row, { permissions: READER, self: null, tasks });
    expect(panel(row).querySelector('img, b')).toBeNull();
    expect(within(panel(row)).getByText('<img src=x onerror="window.__hacked = 1">')).toBeTruthy();
  });
});

describe('Entregar: only the person in charge of the subtask', () => {
  const tasks = (): WorldTask[] => [task({ title: 'Minha', assignee: CARLA }), task({ title: 'Do Bruno', assignee: BRUNO })];

  it('shows it on the subtask of the person of the session and on no other, even with every permission', async () => {
    const row = complete();
    await openAssignment(row, { permissions: [...MANAGER], self: CARLA.membershipId, tasks: tasks() });
    expect(within(taskItem(row, 'Minha')).getByRole('button', { name: 'Entregar “Minha”' })).toBeTruthy();
    expect(within(taskItem(row, 'Do Bruno')).queryByRole('button', { name: /Entregar/ })).toBeNull();
  });

  it.each([
    ['an owner by possession, with no link to the agency', null],
    ['somebody who is in charge of no subtask', ANA.membershipId]
  ])('shows it to nobody: %s', async (_name, self) => {
    const row = complete();
    await openAssignment(row, { permissions: [...MANAGER], self, tasks: tasks() });
    expect(actionNames(row).filter((name) => name.startsWith('Entregar'))).toEqual([]);
  });

  it('shows it to nobody on a subtask with no one in charge, not even to an owner by possession who has no link', async () => {
    const row = complete();
    await openAssignment(row, { permissions: READER, self: null, tasks: [task({ title: 'Sem dono', assignee: null })] });
    expect(actionNames(row)).toEqual([]);
  });

  it('shows it only on a pending subtask', async () => {
    const row = complete();
    const mine = [task({ title: 'Pendente', assignee: CARLA, status: 'pending' }), task({ title: 'Entregue', assignee: CARLA, status: 'delivered' }), task({ title: 'Aprovada', assignee: CARLA, status: 'approved' })];
    await openAssignment(row, { permissions: READER, self: CARLA.membershipId, tasks: mine });
    expect(actionNames(row)).toEqual(['Entregar “Pendente”']);
  });

  it('delivers the one that was clicked, shows it delivered, and leaves the other alone', async () => {
    const row = complete();
    const mine = [task({ title: 'Primeira', assignee: CARLA }), task({ title: 'Segunda', assignee: CARLA })];
    const { calls, world } = await openAssignment(row, { permissions: READER, self: CARLA.membershipId, tasks: mine });
    fireEvent.click(within(taskItem(row, 'Segunda')).getByRole('button', { name: 'Entregar “Segunda”' }));
    await waitFor(() => expect(taskItem(row, 'Segunda').textContent).toContain('Entregue'));
    expect(posts(calls).map((call) => call.path)).toEqual([`/agencies/11111111-1111-4111-8111-111111111111/clients/${padaria.id}/contents/${row.id}/tasks/${mine[1]!.id}/deliver`]);
    expect(world.tasks.map((item) => item.status)).toEqual(['pending', 'delivered']);
    expect(taskItem(row, 'Primeira').textContent).toContain('Pendente');
  });
});

describe('Aprovar and Devolver: the person in charge of the content, or conteudo.aprovar_pela_agencia', () => {
  const delivered = (): WorldTask[] => [task({ title: 'Edição', assignee: BRUNO, status: 'delivered' })];

  it.each([
    ['the person in charge of the content, with only conteudo.visualizar', READER, ANA.membershipId, ANA],
    ['who holds conteudo.aprovar_pela_agencia and is not in charge', APPROVER_ONLY, CARLA.membershipId, ANA],
    ['an owner by possession (no link), who holds conteudo.aprovar_pela_agencia', APPROVER_ONLY, null, ANA]
  ])('shows both to %s', async (_name, permissions, self, owner) => {
    const row = complete();
    await openAssignment(row, { permissions, self, owner, tasks: delivered() });
    expect(actionNames(row)).toEqual(['Aprovar “Edição”', 'Devolver “Edição”']);
  });

  it.each([
    ['who is not in charge and holds only conteudo.visualizar', READER, CARLA.membershipId],
    ['who holds only conteudo.operar, besides reading', [VISUALIZE, READ_CLIENTS, OPERATE], CARLA.membershipId],
    ['the person in charge of the subtask, who is not in charge of the content', READER, BRUNO.membershipId],
    ['an owner by possession (no link) with no permission to approve', READER, null]
  ])('shows neither to %s', async (_name, permissions, self) => {
    const row = complete();
    await openAssignment(row, { permissions, self, owner: ANA, tasks: delivered() });
    expect(actionNames(row)).toEqual([]);
  });

  it.each([
    ['a person with a link', ANA.membershipId],
    ['an owner by possession, who has no link either', null]
  ])('shows neither when there is no one in charge of the content and nobody holds the permission: %s', async (_name, self) => {
    const row = complete();
    await openAssignment(row, { permissions: READER, self, owner: null, tasks: delivered() });
    expect(actionNames(row)).toEqual([]);
  });

  it('shows them only on a delivered subtask', async () => {
    const row = complete();
    const tasks = [task({ title: 'Sem entrega', assignee: BRUNO, status: 'pending' }), task({ title: 'Em revisão', assignee: BRUNO, status: 'delivered' }), task({ title: 'Concluída', assignee: BRUNO, status: 'approved' })];
    await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks });
    expect(within(taskItem(row, 'Em revisão')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Aprovar', 'Devolver']);
    expect(within(taskItem(row, 'Sem entrega')).queryAllByRole('button')).toEqual([]);
    expect(within(taskItem(row, 'Concluída')).queryAllByRole('button')).toEqual([]);
  });

  it('approves the one that was clicked, and the share of approved ones moves', async () => {
    const row = complete();
    const tasks = [task({ title: 'Primeira', status: 'delivered' }), task({ title: 'Segunda', status: 'delivered' }), task({ title: 'Terceira', status: 'pending' })];
    const { calls } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks });
    expect(within(panel(row)).getByRole('status').textContent).toBe('0 de 3 aprovadas (0%)');

    fireEvent.click(within(taskItem(row, 'Segunda')).getByRole('button', { name: 'Aprovar “Segunda”' }));
    await waitFor(() => expect(within(panel(row)).getByRole('status').textContent).toBe('1 de 3 aprovadas (33%)'));
    expect(taskItem(row, 'Segunda').textContent).toContain('Aprovada');
    expect(taskItem(row, 'Primeira').textContent).toContain('Entregue');
    expect(posts(calls).map((call) => [call.path.split('/').at(-2), lastSegment(call.path)])).toEqual([[tasks[1]!.id, 'approve']]);

    fireEvent.click(within(taskItem(row, 'Primeira')).getByRole('button', { name: 'Aprovar “Primeira”' }));
    await waitFor(() => expect(within(panel(row)).getByRole('status').textContent).toBe('2 de 3 aprovadas (67%)'));
  });

  describe('Devolver', () => {
    const open = async () => {
      const row = complete();
      const tasks = [task({ title: 'Edição', assignee: BRUNO, status: 'delivered' }), task({ title: 'Legenda', assignee: BRUNO, status: 'delivered' })];
      const opened = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks });
      return { row, tasks, ...opened };
    };

    it.each([
      ['no comment', '', 'Informe o comentário da devolução.'],
      ['a comment of blanks', '  \n ', 'Informe o comentário da devolução.'],
      ['a comment with an invisible character', 'ok​ok', 'O comentário tem caracteres que não são aceitos, ou passa de 5000 bytes.'],
      ['a comment with a bidi control', 'ok‮ok', 'O comentário tem caracteres que não são aceitos, ou passa de 5000 bytes.'],
      ['a comment of 5.001 bytes', 'a'.repeat(5001), 'O comentário tem caracteres que não são aceitos, ou passa de 5000 bytes.']
    ])('sends nothing with %s, says why, and keeps what was typed', async (_name, comment, text) => {
      const { row, calls } = await open();
      click(row, 'Devolver “Edição”');
      fireEvent.change(within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”'), { target: { value: comment } });
      click(row, 'Confirmar devolução');
      expect(await within(dialogOf(row)).findByText(text)).toBeTruthy();
      expect((within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”') as HTMLTextAreaElement).value).toBe(comment);
      await settled();
      expect(posts(calls)).toEqual([]);
    });

    it('accepts a comment of exactly 5.000 bytes', async () => {
      const { row, calls } = await open();
      click(row, 'Devolver “Edição”');
      fireEvent.change(within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”'), { target: { value: 'a'.repeat(5000) } });
      click(row, 'Confirmar devolução');
      await waitFor(() => expect(posts(calls)).toHaveLength(1));
    });

    it('sends the trimmed comment to the subtask that was clicked, and the subtask goes back to pending with it', async () => {
      const { row, tasks, calls, world } = await open();
      click(row, 'Devolver “Legenda”');
      fireEvent.change(within(dialogOf(row)).getByLabelText('Comentário da devolução de “Legenda”'), { target: { value: '  Falta o áudio  ' } });
      click(row, 'Confirmar devolução');
      await waitFor(() => expect(within(taskItem(row, 'Legenda')).getByText('Devolvida: Falta o áudio')).toBeTruthy());
      expect(taskItem(row, 'Legenda').textContent).toContain('Pendente');
      expect(taskItem(row, 'Edição').textContent).toContain('Entregue');
      expect(posts(calls).map((call) => [call.path.split('/').at(-2), lastSegment(call.path), call.body])).toEqual([[tasks[1]!.id, 'return', { comment: 'Falta o áudio' }]]);
      expect(within(dialogOf(row)).queryByLabelText('Comentário da devolução de “Legenda”')).toBeNull();

      // Delivered again, the subtask asks for a comment again: nothing of the old panel is left open.
      world.tasks[1]!.status = 'delivered';
      click(row, 'Aprovar “Edição”');
      await waitFor(() => expect(taskItem(row, 'Edição').textContent).toContain('Aprovada'));
      expect(within(taskItem(row, 'Legenda')).getByRole('button', { name: 'Devolver “Legenda”' }).getAttribute('aria-expanded')).toBe('false');
      expect(within(dialogOf(row)).queryByLabelText('Comentário da devolução de “Legenda”')).toBeNull();
    });

    it('keeps the comment and the modal when the API refuses, and sends it again on the next try', async () => {
      const { row, calls, world } = await open();
      world.failNext = { match: /\/return$/, response: () => failure(500, 'INTERNAL') };
      click(row, 'Devolver “Edição”');
      fireEvent.change(within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”'), { target: { value: 'Falta o áudio' } });
      click(row, 'Confirmar devolução');
      expect(await within(dialogOf(row)).findByText('Não foi possível devolver a subtarefa. Tente de novo.')).toBeTruthy();
      expect((within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”') as HTMLTextAreaElement).value).toBe('Falta o áudio');
      await settled();
      expect(screen.queryByRole('dialog')).not.toBeNull();

      click(row, 'Confirmar devolução');
      await waitFor(() => expect(within(taskItem(row, 'Edição')).getByText('Devolvida: Falta o áudio')).toBeTruthy());
      expect(posts(calls)).toHaveLength(2);
    });

    it('closes the panel when the button is pressed again, and a second subtask opens its own with nothing of the first', async () => {
      const { row } = await open();
      click(row, 'Devolver “Edição”');
      fireEvent.change(within(dialogOf(row)).getByLabelText('Comentário da devolução de “Edição”'), { target: { value: 'Rascunho' } });
      click(row, 'Devolver “Legenda”');
      expect(within(dialogOf(row)).queryByLabelText('Comentário da devolução de “Edição”')).toBeNull();
      expect((within(dialogOf(row)).getByLabelText('Comentário da devolução de “Legenda”') as HTMLTextAreaElement).value).toBe('');
      click(row, 'Devolver “Legenda”');
      expect(within(dialogOf(row)).queryByLabelText('Comentário da devolução de “Legenda”')).toBeNull();
    });
  });
});

describe('who is in charge of the content', () => {
  it.each([
    ['conteudo.operar only', OPERATOR],
    ['conteudo.aprovar_pela_agencia only', APPROVER_ONLY],
    ['conteudo.visualizar only', READER]
  ])('offers no way to change it to who has %s', async (_name, permissions) => {
    const row = complete();
    await openAssignment(row, { permissions: [...permissions, TEAM], self: ANA.membershipId });
    // The choice would come from the team, which is read a moment after the tab opens: look only after it answered.
    await settled();
    expect(within(panel(row)).queryByLabelText('Novo responsável')).toBeNull();
    expect(within(panel(row)).queryByRole('button', { name: 'Trocar responsável' })).toBeNull();
  });

  it('offers it to who has conteudo.operar and conteudo.aprovar_pela_agencia, by name, and changes it', async () => {
    const row = complete();
    const { calls } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId });
    const select = (await within(panel(row)).findByLabelText('Novo responsável')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Escolha uma pessoa', 'Ana Souza', 'Bruno Lima', 'Carla Dias']));
    expect(Array.from(select.options).some((option) => /[0-9a-f]{8}-/.test(option.textContent ?? ''))).toBe(false);

    fireEvent.change(select, { target: { value: BRUNO.membershipId } });
    click(row, 'Trocar responsável');
    await waitFor(() => expect(within(panel(row)).getByText('Bruno Lima', { selector: 'p' })).toBeTruthy());
    expect(writes(calls).map((call) => [call.method, call.body])).toEqual([['PATCH', { ownerMembershipId: BRUNO.membershipId }]]);
    expect((within(panel(row)).getByLabelText('Novo responsável') as HTMLSelectElement).value).toBe('');
  });

  it('sends nothing when nobody was chosen, and says so', async () => {
    const row = complete();
    const { calls } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId });
    await within(panel(row)).findByLabelText('Novo responsável');
    click(row, 'Trocar responsável');
    expect(await within(panel(row)).findByText('Escolha quem passa a ser o responsável.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('keeps the choice and the modal when the API refuses the person, with its own words', async () => {
    const row = complete();
    await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, team: [ANA, DIOGO] });
    const select = (await within(panel(row)).findByLabelText('Novo responsável')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: DIOGO.membershipId } });
    click(row, 'Trocar responsável');
    expect(await within(panel(row)).findByText('A pessoa escolhida não pode ser responsável: precisa estar ativa e poder ver Conteúdo.')).toBeTruthy();
    expect(select.value).toBe(DIOGO.membershipId);
    expect(within(panel(row)).getByText('Ana Souza', { selector: 'p' })).toBeTruthy();
    await settled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('says in its own words that the person cannot be chosen without seeing the team, and reads no team', async () => {
    const row = complete();
    const { calls } = await openAssignment(row, { permissions: [VISUALIZE, READ_CLIENTS, OPERATE, APPROVE], self: ANA.membershipId });
    expect(within(panel(row)).getByText('Para escolher uma pessoa é preciso poder ver a equipe da agência.')).toBeTruthy();
    expect(within(panel(row)).queryByLabelText('Novo responsável')).toBeNull();
    expect(calls.some((call) => /\/collaborators/.test(call.path))).toBe(false);
  });

  it('shows a skeleton while the team is read, and the choice once it answered', async () => {
    const row = complete();
    let release!: () => void;
    const teamGate = new Promise<void>((resolve) => { release = resolve; });
    await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, teamGate });
    expect(within(panel(row)).queryByLabelText('Novo responsável')).toBeNull();
    expect(panel(row).querySelector('[aria-hidden="true"]')).not.toBeNull();
    release();
    expect(await within(panel(row)).findByLabelText('Novo responsável')).toBeTruthy();
  });

  it('says so and offers to try again when the team cannot be read', async () => {
    const row = complete();
    await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, teamStatus: 403 });
    expect(await within(panel(row)).findByText('Não foi possível carregar a equipe. Tente de novo.')).toBeTruthy();
    expect(within(panel(row)).getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(within(panel(row)).queryByLabelText('Novo responsável')).toBeNull();
  });
});

describe('a new subtask', () => {
  const fill = (row: Stored, values: { title?: string; person?: string; due?: string; description?: string }): void => {
    const area = dialogOf(row);
    if (values.title !== undefined) fireEvent.change(within(area).getByLabelText('Título da subtarefa'), { target: { value: values.title } });
    if (values.person !== undefined) fireEvent.change(within(area).getByLabelText('Responsável pela subtarefa'), { target: { value: values.person } });
    if (values.due !== undefined) fireEvent.change(within(area).getByLabelText('Prazo da subtarefa'), { target: { value: values.due } });
    if (values.description !== undefined) fireEvent.change(within(area).getByLabelText('Descrição da subtarefa (opcional)'), { target: { value: values.description } });
  };
  const openForm = async (row: Stored, options: Partial<AssignmentOptions> = {}, extra: Parameters<typeof openAssignment>[2] = {}) => {
    const opened = await openAssignment(row, { permissions: OPERATOR, self: ANA.membershipId, ...options }, extra);
    click(row, 'Nova subtarefa');
    await waitFor(() => expect((within(dialogOf(row)).getByLabelText('Responsável pela subtarefa') as HTMLSelectElement).options.length).toBeGreaterThan(1));
    return opened;
  };

  it.each([
    ['conteudo.visualizar only', READER],
    ['conteudo.aprovar_pela_agencia only', APPROVER_ONLY]
  ])('offers no way to create one to who has %s', async (_name, permissions) => {
    const row = complete();
    await openAssignment(row, { permissions: [...permissions, TEAM], self: ANA.membershipId });
    expect(within(panel(row)).queryByRole('button', { name: 'Nova subtarefa' })).toBeNull();
  });

  it('sends the title, the person by link, the day and the description, then shows the new subtask and closes the form', async () => {
    const row = complete();
    const { calls } = await openForm(row);
    fill(row, { title: '  Gravar o vídeo  ', person: CARLA.membershipId, due: '2026-10-18', description: 'Em 4K' });
    click(row, 'Criar subtarefa');
    await waitFor(() => expect(taskItem(row, 'Gravar o vídeo').textContent).toContain('Responsável: Carla Dias · Prazo: 18/10/2026 · Pendente'));
    expect(writes(calls).map((call) => [call.method, call.body])).toEqual([['POST', { title: 'Gravar o vídeo', description: 'Em 4K', assigneeMembershipId: CARLA.membershipId, dueOn: '2026-10-18' }]]);
    expect(within(panel(row)).queryByLabelText('Título da subtarefa')).toBeNull();
    expect(within(panel(row)).getByRole('status').textContent).toBe('0 de 1 aprovada (0%)');
  });

  it('leaves the description out when it is blank', async () => {
    const row = complete();
    const { calls } = await openForm(row);
    fill(row, { title: 'Sem descrição', person: BRUNO.membershipId, due: '2026-10-18', description: '   ' });
    click(row, 'Criar subtarefa');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({ title: 'Sem descrição', assigneeMembershipId: BRUNO.membershipId, dueOn: '2026-10-18' });
  });

  it.each([
    ['no title', { person: ANA.membershipId, due: '2026-10-18' }, 'Informe o título da subtarefa, em uma linha e com até 120 caracteres.'],
    ['a title with an invisible character', { title: 'a\u200Bb', person: ANA.membershipId, due: '2026-10-18' }, 'Informe o título da subtarefa, em uma linha e com até 120 caracteres.'],
    ['a title of 121 characters', { title: 'a'.repeat(121), person: ANA.membershipId, due: '2026-10-18' }, 'Informe o título da subtarefa, em uma linha e com até 120 caracteres.'],
    ['nobody in charge', { title: 'Gravar', due: '2026-10-18' }, 'Escolha o responsável.'],
    ['no day', { title: 'Gravar', person: ANA.membershipId }, 'Informe o prazo.'],
    ['a description with an invisible character', { title: 'Gravar', person: ANA.membershipId, due: '2026-10-18', description: 'ok​ok' }, 'A descrição tem caracteres que não são aceitos, ou passa de 20000 bytes.']
  ])('sends nothing with %s, and says why', async (_name, values, text) => {
    const row = complete();
    const { calls } = await openForm(row);
    fill(row, values);
    click(row, 'Criar subtarefa');
    expect(await within(dialogOf(row)).findByText(text)).toBeTruthy();
    await settled();
    expect(writes(calls)).toEqual([]);
  });

  it('keeps everything typed and the modal when the API refuses, in its own words, and creates on the next try', async () => {
    const row = complete();
    const { calls, world } = await openForm(row);
    world.failNext = { match: /\/tasks$/, response: () => failure(409, 'TRY_AGAIN') };
    fill(row, { title: 'Gravar', person: BRUNO.membershipId, due: '2026-10-18', description: 'Em 4K' });
    click(row, 'Criar subtarefa');
    expect(await within(dialogOf(row)).findByText('Outra alteração aconteceu ao mesmo tempo. Tente de novo.')).toBeTruthy();
    expect((within(dialogOf(row)).getByLabelText('Título da subtarefa') as HTMLInputElement).value).toBe('Gravar');
    expect((within(dialogOf(row)).getByLabelText('Responsável pela subtarefa') as HTMLSelectElement).value).toBe(BRUNO.membershipId);
    expect((within(dialogOf(row)).getByLabelText('Prazo da subtarefa') as HTMLInputElement).value).toBe('2026-10-18');
    expect((within(dialogOf(row)).getByLabelText('Descrição da subtarefa (opcional)') as HTMLTextAreaElement).value).toBe('Em 4K');
    await settled();
    expect(screen.queryByRole('dialog')).not.toBeNull();

    click(row, 'Criar subtarefa');
    await waitFor(() => expect(taskItem(row, 'Gravar')).toBeTruthy());
    expect(posts(calls)).toHaveLength(2);
  });

  it('says in its own words that the person cannot be in charge, and keeps the form', async () => {
    const row = complete();
    const { world } = await openForm(row, { team: [ANA, DIOGO] });
    void world;
    fill(row, { title: 'Gravar', person: DIOGO.membershipId, due: '2026-10-18' });
    click(row, 'Criar subtarefa');
    expect(await within(dialogOf(row)).findByText('A pessoa escolhida não pode ser responsável: precisa estar ativa e poder ver Conteúdo.')).toBeTruthy();
    expect((within(dialogOf(row)).getByLabelText('Título da subtarefa') as HTMLInputElement).value).toBe('Gravar');
  });

  it('closes the form without sending, and opens it empty the next time', async () => {
    const row = complete();
    const { calls } = await openForm(row);
    fill(row, { title: 'Rascunho' });
    click(row, 'Cancelar');
    expect(within(dialogOf(row)).queryByLabelText('Título da subtarefa')).toBeNull();
    click(row, 'Nova subtarefa');
    expect((within(dialogOf(row)).getByLabelText('Título da subtarefa') as HTMLInputElement).value).toBe('Rascunho');
    expect(writes(calls)).toEqual([]);
  });

  describe('the limit of 50', () => {
    const fifty = (): WorldTask[] => Array.from({ length: 50 }, (_item, index) => task({ title: `Item ${index + 1}` }));

    it('offers no new subtask at 50, with the reason in its own words', async () => {
      const row = complete();
      await openAssignment(row, { permissions: OPERATOR, self: ANA.membershipId, tasks: fifty() });
      expect(within(panel(row)).queryByRole('button', { name: 'Nova subtarefa' })).toBeNull();
      expect(within(panel(row)).getByText('Um conteúdo leva no máximo 50 subtarefas.')).toBeTruthy();
    });

    it('answers the 409 of the limit with its own words inside the form, and keeps what was typed, when the list still says less than 50', async () => {
      const row = complete();
      const { world } = await openForm(row, { tasks: fifty().slice(0, 40) });
      world.refuseLimit = true;
      fill(row, { title: 'Gravar', person: ANA.membershipId, due: '2026-10-18' });
      click(row, 'Criar subtarefa');
      expect(await within(dialogOf(row)).findByText('Um conteúdo leva no máximo 50 subtarefas.')).toBeTruthy();
      expect((within(dialogOf(row)).getByLabelText('Título da subtarefa') as HTMLInputElement).value).toBe('Gravar');
    });

    it('offers it at 49, and the 51st the API refuses (the screen was stale) has its own text, and the screen then reads the 51 and offers no more', async () => {
      const row = complete();
      const { world, calls } = await openForm(row, { tasks: fifty().slice(0, 49) });
      expect(within(panel(row)).queryByText('Um conteúdo leva no máximo 50 subtarefas.')).toBeNull();
      // Another operator created the 50th and the 51st in the meantime.
      world.tasks.push(task({ title: 'Do outro operador' }), task({ title: 'Do outro operador 2' }));
      fill(row, { title: 'Gravar', person: ANA.membershipId, due: '2026-10-18' });
      click(row, 'Criar subtarefa');
      expect(await within(dialogOf(row)).findByText('Um conteúdo leva no máximo 50 subtarefas.')).toBeTruthy();
      await waitFor(() => expect(within(panel(row)).getByText('Do outro operador 2')).toBeTruthy());
      expect(within(panel(row)).queryByRole('button', { name: 'Nova subtarefa' })).toBeNull();
      expect(posts(calls)).toHaveLength(1);
    });
  });
});

describe('what the API refuses on a move, in the screen\'s own words', () => {
  it.each([
    [409, 'CONTENT_TASK_STATE', 'A subtarefa mudou de estado, ou o conteúdo já foi publicado ou cancelado. Feche e abra de novo para ver o estado atual.'],
    [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.'],
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o conteúdo é só leitura.'],
    [403, 'FORBIDDEN', 'Só o responsável pelo conteúdo, ou quem pode aprovar pela agência, aprova uma subtarefa.'],
    [404, 'NOT_FOUND', 'Esta subtarefa não existe mais.'],
    [500, 'INTERNAL', 'Não foi possível aprovar a subtarefa. Tente de novo.']
  ])('answers %s %s on Aprovar, keeps the modal open and shows nothing from the server', async (status, code, text) => {
    const row = complete();
    const { world } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks: [task({ title: 'Edição', status: 'delivered' })] });
    world.failNext = { match: /\/approve$/, response: () => failure(status, code) };
    click(row, 'Aprovar “Edição”');
    expect(await within(taskItem(row, 'Edição')).findByText(text)).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    await settled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('says in its own words that only the person in charge delivers, when the API says 403', async () => {
    const row = complete();
    const { world } = await openAssignment(row, { permissions: READER, self: CARLA.membershipId, tasks: [task({ title: 'Minha', assignee: CARLA })] });
    world.failNext = { match: /\/deliver$/, response: () => failure(403, 'FORBIDDEN') };
    click(row, 'Entregar “Minha”');
    expect(await within(taskItem(row, 'Minha')).findByText('Só quem é responsável pela subtarefa a entrega.')).toBeTruthy();
  });

  it('shows the refusal under the subtask that was clicked and under no other', async () => {
    const row = complete();
    const { world } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks: [task({ title: 'Primeira', status: 'delivered' }), task({ title: 'Segunda', status: 'delivered' })] });
    world.failNext = { match: /\/approve$/, response: () => failure(409, 'TRY_AGAIN') };
    click(row, 'Aprovar “Segunda”');
    await within(taskItem(row, 'Segunda')).findByText('Outra alteração aconteceu ao mesmo tempo. Tente de novo.');
    expect(within(taskItem(row, 'Primeira')).queryByRole('alert')).toBeNull();
  });

  it('sends once when a move is clicked twice, and holds the other buttons while it is on its way', async () => {
    const row = complete();
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const { calls, world } = await openAssignment(row, { permissions: MANAGER, self: ANA.membershipId, tasks: [task({ title: 'Primeira', status: 'delivered' }), task({ title: 'Segunda', status: 'delivered' })] });
    world.hold = { match: /\/approve$/, promise };
    const first = within(taskItem(row, 'Primeira')).getByRole('button', { name: 'Aprovar “Primeira”' });
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(within(taskItem(row, 'Segunda')).getByRole('button', { name: 'Aprovar “Segunda”' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect((within(taskItem(row, 'Segunda')).getByRole('button', { name: 'Aprovar “Segunda”' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(taskItem(row, 'Primeira').textContent).toContain('Aprovada'));
    expect(posts(calls)).toHaveLength(1);
    expect(taskItem(row, 'Segunda').textContent).toContain('Entregue');
  });
});

describe('what cannot be written', () => {
  const writableOptions = { permissions: MANAGER, self: ANA.membershipId, tasks: [task({ title: 'Minha', assignee: ANA, status: 'pending' }), task({ title: 'Em revisão', assignee: BRUNO, status: 'delivered' })] } as const;

  it('shows the whole tab and not one control of a content of an archived client', async () => {
    const row = complete({ clientId: barbearia.id });
    const { world, scenario } = assignmentWorld(writableOptions);
    void world;
    const entry = `${base(barbearia.id)}/${row.id}`;
    const { impl } = makeFetch(scenario([row], { contents: [row] }));
    render_(impl, entry);
    await screen.findByLabelText('Título');
    await waitFor(() => expect((screen.getByRole('tab', { name: 'Atribuição' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('tab', { name: 'Atribuição' }));
    const area = await screen.findByRole('tabpanel', { name: 'Atribuição' });
    expect(within(area).getByText('Cliente arquivado: o conteúdo é só leitura.')).toBeTruthy();
    expect(within(area).getByText('Em revisão')).toBeTruthy();
    expect(within(area).queryAllByRole('button')).toEqual([]);
    expect(within(area).queryByLabelText('Novo responsável')).toBeNull();
  });

  it.each(['published', 'cancelled'] as const)('shows a %s content as read-only: no move, no new subtask, no change of owner', async (status) => {
    const row = complete({ status });
    await openAssignment(row, writableOptions);
    expect(within(panel(row)).getByText('Este conteúdo já foi publicado ou cancelado: a atribuição é só leitura.')).toBeTruthy();
    expect(within(panel(row)).queryAllByRole('button')).toEqual([]);
    expect(within(panel(row)).queryByLabelText('Novo responsável')).toBeNull();
  });
});
