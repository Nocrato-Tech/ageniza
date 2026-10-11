import {
  CONTENT_TASKS_MAX_PER_CONTENT,
  CreateContentTaskRequestSchema,
  ReturnContentTaskRequestSchema,
  type ContentDetail,
  type ContentTask
} from '@ageniza/contracts';

import { HttpClientError } from './http.js';

/** What a person does to a subtask: the three moves of its state, and creating one (`specs/conteudo.md` section 4). */
export type TaskMove = 'deliver' | 'approve' | 'return';

export const TASK_STATUS_LABELS: Readonly<Record<ContentTask['status'], string>> = {
  pending: 'Pendente',
  delivered: 'Entregue',
  approved: 'Aprovada'
};

export const TASK_LIMIT_TEXT = `Um conteúdo leva no máximo ${CONTENT_TASKS_MAX_PER_CONTENT} subtarefas.`;

/** The share of approved subtasks over all of them; nothing without subtasks, so no "0%" over an empty list. */
export const taskProgress = (tasks: readonly ContentTask[]): { approved: number; total: number; percent: number } | null => {
  if (tasks.length === 0) return null;
  const approved = tasks.filter((task) => task.status === 'approved').length;
  return { approved, total: tasks.length, percent: Math.round((approved / tasks.length) * 100) };
};

/** Derived, never stored: the day to deliver is past and the subtask is not approved (`specs/conteudo.md` section 4). */
export const isTaskOverdue = (task: ContentTask, today: string): boolean => task.status !== 'approved' && task.dueOn < today;

/** Only the person in charge of the subtask delivers it, whatever else they may do; `self` is `null` for who has no link to the agency, and `null` is never a membership. */
export const canDeliver = (task: ContentTask, self: string | null): boolean =>
  task.status === 'pending' && task.assignee?.membershipId === self;

/** The person in charge of the content, or who holds `conteudo.aprovar_pela_agencia`, approves or returns a delivered subtask. */
export const canJudge = (task: ContentTask, content: Pick<ContentDetail, 'owner'>, self: string | null, canApproveForAgency: boolean): boolean =>
  task.status === 'delivered' && (content.owner?.membershipId === self || canApproveForAgency);

export const COMMENT_REQUIRED = 'Informe o comentário da devolução.';

/** The comment of a return, by the contract's own rule; the words are the screen's. */
export const commentIssue = (value: string): string | undefined => {
  if (ReturnContentTaskRequestSchema.safeParse({ comment: value }).success) return undefined;
  return value.trim() === '' ? COMMENT_REQUIRED : 'O comentário tem caracteres que não são aceitos, ou passa de 5000 bytes.';
};

export interface NewTaskValues {
  readonly title: string;
  readonly description: string;
  readonly assigneeMembershipId: string;
  readonly dueOn: string;
}

export type NewTaskErrors = Partial<Record<keyof NewTaskValues, string>>;

const FIELD_TEXT: Readonly<Record<keyof NewTaskValues, string>> = {
  title: 'Informe o título da subtarefa, em uma linha e com até 120 caracteres.',
  description: 'A descrição tem caracteres que não são aceitos, ou passa de 20000 bytes.',
  assigneeMembershipId: 'Escolha o responsável.',
  dueOn: 'Informe o prazo.'
};

/** The body of a new subtask by the contract's own schema; a refusal is worded per field, and the first of each field wins. */
export const newTaskBody = (values: NewTaskValues): { body: ReturnType<typeof CreateContentTaskRequestSchema.parse> } | { errors: NewTaskErrors } => {
  const parsed = CreateContentTaskRequestSchema.safeParse({
    title: values.title,
    ...(values.description.trim() === '' ? {} : { description: values.description }),
    assigneeMembershipId: values.assigneeMembershipId,
    dueOn: values.dueOn
  });
  if (parsed.success) return { body: parsed.data };
  const errors: NewTaskErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'title' || field === 'description' || field === 'assigneeMembershipId' || field === 'dueOn') errors[field] ??= FIELD_TEXT[field];
  }
  return { errors };
};

const TASK_FAILED: Readonly<Record<TaskMove | 'create', string>> = {
  create: 'Não foi possível criar a subtarefa. Tente de novo.',
  deliver: 'Não foi possível entregar a subtarefa. Tente de novo.',
  approve: 'Não foi possível aprovar a subtarefa. Tente de novo.',
  return: 'Não foi possível devolver a subtarefa. Tente de novo.'
};

const TASK_FORBIDDEN: Readonly<Record<TaskMove | 'create', string>> = {
  create: 'Você não tem permissão para criar subtarefas.',
  deliver: 'Só quem é responsável pela subtarefa a entrega.',
  approve: 'Só o responsável pelo conteúdo, ou quem pode aprovar pela agência, aprova uma subtarefa.',
  return: 'Só o responsável pelo conteúdo, ou quem pode aprovar pela agência, devolve uma subtarefa.'
};

const ASSIGNEE_INVALID = 'A pessoa escolhida não pode ser responsável: precisa estar ativa e poder ver Conteúdo.';

/** The screen's own words for each refusal of a subtask: what the server wrote is never shown. */
export const taskRefusal = (error: unknown, move: TaskMove | 'create'): string => {
  if (error instanceof HttpClientError) {
    const { status, code } = error;
    if (status === 409 && code === 'CONTENT_TASK_LIMIT') return TASK_LIMIT_TEXT;
    if (status === 409 && code === 'CONTENT_TASK_STATE') return 'A subtarefa mudou de estado, ou o conteúdo já foi publicado ou cancelado. Feche e abra de novo para ver o estado atual.';
    if (status === 409 && code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: o conteúdo é só leitura.';
    if (status === 409 && code === 'TRY_AGAIN') return 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.';
    if (status === 400 && code === 'CONTENT_TASK_ASSIGNEE_INVALID') return ASSIGNEE_INVALID;
    if (status === 400 && code === 'CONTENT_TASK_COMMENT_INVALID') return 'O comentário da devolução não foi aceito. Revise o texto.';
    if (status === 403) return TASK_FORBIDDEN[move];
    if (status === 404) return 'Esta subtarefa não existe mais.';
  }
  return TASK_FAILED[move];
};

/** The screen's own words for each refusal of a change of the person in charge of the content. */
export const ownerRefusal = (error: unknown): string => {
  if (error instanceof HttpClientError) {
    const { status, code } = error;
    if (status === 400 && code === 'CONTENT_OWNER_INVALID') return ASSIGNEE_INVALID;
    if (status === 409 && code === 'CONTENT_NOT_EDITABLE') return 'Este conteúdo já foi publicado ou cancelado e não pode mudar de responsável.';
    if (status === 409 && code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: o conteúdo é só leitura.';
    if (status === 409 && code === 'TRY_AGAIN') return 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.';
    if (status === 403) return 'Só quem pode aprovar pela agência troca o responsável pelo conteúdo.';
    if (status === 404) return 'Este conteúdo não existe mais.';
  }
  return 'Não foi possível trocar o responsável. Tente de novo.';
};
