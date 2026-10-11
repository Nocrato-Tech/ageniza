import { useId, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  ContentDetailSchema,
  ContentTaskSchema,
  CONTENT_TASKS_MAX_PER_CONTENT,
  type ContentDetail,
  type ContentTask,
  type ReturnContentTaskRequest,
  type UpdateContentRequest
} from '@ageniza/contracts';
import { Button, FieldMessage, Select, Skeleton, Textarea, TextInput } from '@ageniza/ui';

import { useAgencyContext, useCan } from './agency.js';
import { apiPath } from './api-path.js';
import {
  canDeliver,
  canJudge,
  commentIssue,
  isTaskOverdue,
  newTaskBody,
  ownerRefusal,
  taskProgress,
  taskRefusal,
  TASK_LIMIT_TEXT,
  TASK_STATUS_LABELS,
  type NewTaskErrors,
  type NewTaskValues,
  type TaskMove
} from './content-assignment-rules.js';
import { todayInSaoPaulo } from './content-dates.js';
import { isClosed } from './content-labels.js';
import { useTeam, type TeamMember } from './content-team.js';
import { useApiClient } from './http.js';

const CONTENT_PATH = '/agencies/:agencyId/clients/:clientId/contents/:contentId';
const TASKS_PATH = `${CONTENT_PATH}/tasks`;

const dayLabel = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

const EMPTY_TASK: NewTaskValues = { title: '', description: '', assigneeMembershipId: '', dueOn: '' };

/** The two blocks of the Atribuição tab (`specs/conteudo.md` section 7): who is in charge of the content, and its subtasks. */
export function ContentAssignment({ clientId, content, archived }: { clientId: string; content: ContentDetail; archived: boolean }) {
  const httpClient = useApiClient();
  const agency = useAgencyContext();
  const queryClient = useQueryClient();
  const canOperate = useCan('conteudo.operar');
  const canApprove = useCan('conteudo.aprovar_pela_agencia');
  const canSeeTeam = useCan('colaborador.visualizar');
  // `null` for an owner by possession, who has no link: the permissions decide for her.
  const self = agency.membershipId;
  const writable = !archived && !isClosed(content.status);
  const canChangeOwner = writable && canOperate && canApprove;
  const canCreate = writable && canOperate;
  const atLimit = content.tasks.length >= CONTENT_TASKS_MAX_PER_CONTENT;
  const team = useTeam((canChangeOwner || canCreate) && canSeeTeam);

  // What is on its way is this screen's own state, set in the click, and every button waits for it.
  const [sending, setSending] = useState<string | null>(null);
  const busy = sending !== null;

  const [owner, setOwner] = useState('');
  const [ownerError, setOwnerError] = useState<string | undefined>();
  const [taskErrors, setTaskErrors] = useState<Readonly<Record<string, string>>>({});
  const [returning, setReturning] = useState<{ taskId: string; comment: string; problem?: string | undefined } | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<NewTaskValues>(EMPTY_TASK);
  const [draftErrors, setDraftErrors] = useState<NewTaskErrors>({});
  const [createError, setCreateError] = useState<string | undefined>();
  const ids = useId();

  /** Runs one write, refreshes what the calendar and the modal read, and gives back the error or `undefined`. */
  const run = async (key: string, request: () => Promise<unknown>): Promise<{ failed: unknown } | undefined> => {
    if (sending !== null) return { failed: undefined };
    setSending(key);
    try {
      await request();
      await queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      return undefined;
    } catch (failed) {
      void queryClient.invalidateQueries({ queryKey: ['agency', agency.agencyId, 'contents', clientId] });
      return { failed };
    } finally {
      setSending(null);
    }
  };

  const contentPath = apiPath(CONTENT_PATH, { agencyId: agency.agencyId, clientId, contentId: content.id });
  const taskPath = (taskId: string, move: TaskMove): string => `${apiPath(TASKS_PATH, { agencyId: agency.agencyId, clientId, contentId: content.id })}/${taskId}/${move}`;

  const changeOwner = async (): Promise<void> => {
    if (owner === '') { setOwnerError('Escolha quem passa a ser o responsável.'); return; }
    setOwnerError(undefined);
    const result = await run('owner', () => httpClient.request({
      path: contentPath,
      method: 'PATCH',
      body: { ownerMembershipId: owner } satisfies UpdateContentRequest,
      response: ContentDetailSchema
    }));
    if (result === undefined) setOwner(''); else if (result.failed !== undefined) setOwnerError(ownerRefusal(result.failed));
  };

  const move = async (task: ContentTask, action: TaskMove, body?: ReturnContentTaskRequest): Promise<boolean> => {
    setTaskErrors((current) => ({ ...current, [task.id]: '' }));
    const result = await run(`${task.id}:${action}`, () => httpClient.request({
      path: taskPath(task.id, action),
      method: 'POST',
      ...(body === undefined ? {} : { body }),
      response: ContentTaskSchema
    }));
    if (result === undefined) return true;
    if (result.failed !== undefined) setTaskErrors((current) => ({ ...current, [task.id]: taskRefusal(result.failed, action) }));
    return false;
  };

  const confirmReturn = async (task: ContentTask): Promise<void> => {
    if (returning === null || returning.taskId !== task.id) return;
    const problem = commentIssue(returning.comment);
    if (problem !== undefined) { setReturning({ ...returning, problem }); return; }
    if (await move(task, 'return', { comment: returning.comment.trim() })) setReturning(null);
  };

  const create = async (): Promise<void> => {
    const built = newTaskBody(draft);
    if ('errors' in built) { setDraftErrors(built.errors); setCreateError(undefined); return; }
    setDraftErrors({});
    setCreateError(undefined);
    const result = await run('create', () => httpClient.request({
      path: apiPath(TASKS_PATH, { agencyId: agency.agencyId, clientId, contentId: content.id }),
      method: 'POST',
      body: built.body,
      response: ContentTaskSchema
    }));
    if (result === undefined) { setDraft(EMPTY_TASK); setCreating(false); } else if (result.failed !== undefined) setCreateError(taskRefusal(result.failed, 'create'));
  };

  const edit = (patch: Partial<NewTaskValues>, field: keyof NewTaskValues): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setDraftErrors((current) => ({ ...current, [field]: undefined }));
    setCreateError(undefined);
  };

  const progress = taskProgress(content.tasks);
  const today = todayInSaoPaulo();
  const teamOptions = (team.data ?? []).map((member: TeamMember) => ({ value: member.membershipId, label: member.label }));
  const teamBlocked: ReactNode = !canSeeTeam
    ? <p className="form-hint">Para escolher uma pessoa é preciso poder ver a equipe da agência.</p>
    : team.isError
      ? <div role="alert">
        <p>Não foi possível carregar a equipe. Tente de novo.</p>
        <Button size="sm" variant="secondary" onClick={() => { void team.refetch(); }}>Tentar de novo</Button>
      </div>
      : team.isPending
        ? <div aria-hidden="true"><Skeleton /></div>
        : null;
  const teamReady = canSeeTeam && team.data !== undefined;

  return <div className="content-assignment">
    {archived && <p className="form-hint" role="note">Cliente arquivado: o conteúdo é só leitura.</p>}
    {!archived && isClosed(content.status) && <p className="form-hint" role="note">Este conteúdo já foi publicado ou cancelado: a atribuição é só leitura.</p>}

    <section className="content-assignment__block" aria-labelledby={`${ids}-owner`}>
      <h3 id={`${ids}-owner`}>Responsável pelo conteúdo</h3>
      <p>{content.owner?.name ?? 'Sem responsável'}</p>
      {canChangeOwner && (teamReady
        ? <div className="form-stack">
          <Select
            label="Novo responsável"
            value={owner}
            options={teamOptions}
            placeholder="Escolha uma pessoa"
            disabled={busy}
            onChange={(value) => { setOwner(value); setOwnerError(undefined); }}
          />
          {ownerError !== undefined && <FieldMessage role="alert">{ownerError}</FieldMessage>}
          <div className="form-actions">
            <Button variant="secondary" loading={sending === 'owner'} disabled={busy} onClick={() => { void changeOwner(); }}>Trocar responsável</Button>
          </div>
        </div>
        : teamBlocked)}
    </section>

    <section className="content-assignment__block" aria-labelledby={`${ids}-tasks`}>
      <h3 id={`${ids}-tasks`}>Subtarefas</h3>
      {progress === null
        ? <p className="form-hint">Nenhuma subtarefa ainda.</p>
        : <p role="status">{progress.approved} de {progress.total} {progress.total === 1 ? 'aprovada' : 'aprovadas'} ({progress.percent}%)</p>}
      {content.tasks.length > 0 && <ul className="content-assignment__tasks">
        {content.tasks.map((task) => {
          const overdue = isTaskOverdue(task, today);
          const error = taskErrors[task.id];
          const deliver = writable && canDeliver(task, self);
          const judge = writable && canJudge(task, content, self, canApprove);
          const panel = returning !== null && returning.taskId === task.id ? returning : null;
          const open = panel !== null;
          return <li key={task.id} className="content-assignment__task">
            <p className="content-assignment__task-title">{task.title}</p>
            <p className="content-assignment__task-meta">
              <span>Responsável: {task.assignee?.name ?? 'sem responsável'}</span>
              {' · '}<span>Prazo: {dayLabel(task.dueOn)}</span>
              {' · '}<span>{TASK_STATUS_LABELS[task.status]}</span>
              {overdue && <>{' · '}<span className="content-assignment__late">Atrasada</span></>}
            </p>
            {task.description !== null && <p className="content-assignment__task-description">{task.description}</p>}
            {task.status === 'pending' && task.returnComment !== null && <p className="content-assignment__task-return">Devolvida: {task.returnComment}</p>}
            {(deliver || judge) && <div className="form-actions">
              {deliver && <Button
                size="sm"
                aria-label={`Entregar “${task.title}”`}
                loading={sending === `${task.id}:deliver`}
                disabled={busy}
                onClick={() => { void move(task, 'deliver'); }}
              >Entregar</Button>}
              {judge && <Button
                size="sm"
                aria-label={`Aprovar “${task.title}”`}
                loading={sending === `${task.id}:approve`}
                disabled={busy}
                onClick={() => { void move(task, 'approve'); }}
              >Aprovar</Button>}
              {judge && <Button
                size="sm"
                variant="secondary"
                aria-label={`Devolver “${task.title}”`}
                aria-expanded={open}
                disabled={busy}
                onClick={() => setReturning(open ? null : { taskId: task.id, comment: '' })}
              >Devolver</Button>}
            </div>}
            {judge && panel !== null && <div className="form-field">
              <label htmlFor={`${ids}-return-${task.id}`}>Comentário da devolução de “{task.title}”</label>
              <Textarea
                id={`${ids}-return-${task.id}`}
                rows={3}
                value={panel.comment}
                disabled={busy}
                onChange={(event) => setReturning({ taskId: task.id, comment: event.target.value })}
                aria-invalid={panel.problem !== undefined}
              />
              {panel.problem !== undefined && <FieldMessage role="alert">{panel.problem}</FieldMessage>}
              <div className="form-actions">
                <Button loading={sending === `${task.id}:return`} disabled={busy} onClick={() => { void confirmReturn(task); }}>Confirmar devolução</Button>
              </div>
            </div>}
            {error !== undefined && error !== '' && <FieldMessage role="alert">{error}</FieldMessage>}
          </li>;
        })}
      </ul>}

      {canCreate && (atLimit
        ? <p className="form-hint" role="note">{TASK_LIMIT_TEXT}</p>
        : creating
          ? (teamReady
            ? <div className="form-stack content-assignment__new">
              <div className="form-field">
                <label htmlFor={`${ids}-title`}>Título da subtarefa</label>
                <TextInput
                  id={`${ids}-title`}
                  value={draft.title}
                  disabled={busy}
                  onChange={(event) => edit({ title: event.target.value }, 'title')}
                  aria-invalid={draftErrors.title !== undefined}
                />
                {draftErrors.title !== undefined && <FieldMessage role="alert">{draftErrors.title}</FieldMessage>}
              </div>
              <Select
                label="Responsável pela subtarefa"
                value={draft.assigneeMembershipId}
                options={teamOptions}
                placeholder="Escolha uma pessoa"
                disabled={busy}
                onChange={(value) => edit({ assigneeMembershipId: value }, 'assigneeMembershipId')}
              />
              {draftErrors.assigneeMembershipId !== undefined && <FieldMessage role="alert">{draftErrors.assigneeMembershipId}</FieldMessage>}
              <div className="form-field">
                <label htmlFor={`${ids}-due`}>Prazo da subtarefa</label>
                <TextInput
                  id={`${ids}-due`}
                  type="date"
                  value={draft.dueOn}
                  disabled={busy}
                  onChange={(event) => edit({ dueOn: event.target.value }, 'dueOn')}
                  aria-invalid={draftErrors.dueOn !== undefined}
                />
                {draftErrors.dueOn !== undefined && <FieldMessage role="alert">{draftErrors.dueOn}</FieldMessage>}
              </div>
              <div className="form-field">
                <label htmlFor={`${ids}-description`}>Descrição da subtarefa (opcional)</label>
                <Textarea
                  id={`${ids}-description`}
                  rows={3}
                  value={draft.description}
                  disabled={busy}
                  onChange={(event) => edit({ description: event.target.value }, 'description')}
                  aria-invalid={draftErrors.description !== undefined}
                />
                {draftErrors.description !== undefined && <FieldMessage role="alert">{draftErrors.description}</FieldMessage>}
              </div>
              {createError !== undefined && <FieldMessage role="alert">{createError}</FieldMessage>}
              <div className="form-actions">
                <Button loading={sending === 'create'} disabled={busy} onClick={() => { void create(); }}>Criar subtarefa</Button>
                <Button variant="ghost" disabled={busy} onClick={() => { setCreating(false); }}>Cancelar</Button>
              </div>
            </div>
            : teamBlocked)
          : <div className="form-actions">
            <Button variant="secondary" disabled={busy} onClick={() => { setCreating(true); }}>Nova subtarefa</Button>
          </div>)}
    </section>
  </div>;
}
