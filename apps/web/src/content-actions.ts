import { ContentReasonSchema, type ContentDetail, type ContentFormat, type ContentStatus } from '@ageniza/contracts';

import { HttpClientError } from './http.js';

/** The six moves the agency makes (`specs/conteudo.md` section 4); each is a route of its own. */
export type ContentAction = 'submit' | 'approve' | 'publish' | 'unpublish' | 'cancel' | 'reschedule';

interface ActionRule {
  readonly permission: string;
  /** The states in which the move exists: nothing goes from "em produção" to "aprovado" (rule 5). */
  readonly states: readonly ContentStatus[];
  readonly label: string;
  /** The last segment of the route. */
  readonly segment: string;
}

export const ACTION_RULES: Readonly<Record<ContentAction, ActionRule>> = {
  submit: { permission: 'conteudo.operar', states: ['in_production', 'adjusting'], label: 'Enviar para aprovação', segment: 'submit' },
  approve: { permission: 'conteudo.aprovar_pela_agencia', states: ['awaiting_approval'], label: 'Aprovar pela agência', segment: 'approve-by-agency' },
  publish: { permission: 'conteudo.publicar', states: ['approved'], label: 'Marcar como publicado', segment: 'publish' },
  unpublish: { permission: 'conteudo.publicar', states: ['published'], label: 'Desfazer publicação', segment: 'unpublish' },
  cancel: { permission: 'conteudo.cancelar', states: ['in_production', 'awaiting_approval', 'adjusting', 'approved'], label: 'Cancelar conteúdo', segment: 'cancel' },
  reschedule: { permission: 'conteudo.operar', states: ['cancelled'], label: 'Reagendar', segment: 'reschedule' }
};

export const ACTION_ORDER: readonly ContentAction[] = ['submit', 'approve', 'publish', 'unpublish', 'reschedule', 'cancel'];

/** What the person may do with a content in this state: the permission AND the state, never one alone. UX only: the API decides. */
export const actionsFor = (status: ContentStatus, can: (permission: string) => boolean): ContentAction[] =>
  ACTION_ORDER.filter((action) => ACTION_RULES[action].states.includes(status) && can(ACTION_RULES[action].permission));

interface FolderAsset { readonly id: string; readonly category: 'image' | 'video' }

/**
 * What the content still lacks before it can be sent (`specs/conteudo.md` rule 11): the media complete for the format,
 * every media confirmed and still in the folder, and every subtask approved. The assets are the confirmed ones of the
 * folder; `undefined` means they were not read, and then only what the content itself says is told.
 */
export const missingForSubmit = (
  content: Pick<ContentDetail, 'format' | 'media' | 'coverAssetId' | 'tasks'>,
  assets: readonly FolderAsset[] | undefined
): string[] => {
  const missing: string[] = [];
  const ids = [...content.media].sort((a, b) => a.position - b.position).map((item) => item.id);
  const format: ContentFormat = content.format;
  if (format === 'carousel') {
    if (ids.length === 0) missing.push('Faltam as mídias do carrossel: ele leva de 2 a 20.');
    else if (ids.length === 1) missing.push('Falta pelo menos mais 1 mídia: um carrossel leva de 2 a 20.');
  } else if (ids.length === 0) {
    missing.push(format === 'image' ? 'Falta a imagem do post.' : 'Falta o vídeo do post.');
  }
  if (assets !== undefined) {
    const known = new Map(assets.map((asset) => [asset.id, asset.category]));
    if (ids.some((id) => !known.has(id))) missing.push('Há mídia que ainda não terminou de subir ou que saiu da pasta.');
    const kinds = ids.flatMap((id) => (known.has(id) ? [known.get(id)!] : []));
    if (format === 'image' && kinds.includes('video')) missing.push('A mídia escolhida é um vídeo e este formato leva uma imagem.');
    if (format !== 'image' && format !== 'carousel' && kinds.includes('image')) missing.push('A mídia escolhida é uma imagem e este formato leva um vídeo.');
    if (content.coverAssetId !== null && known.get(content.coverAssetId) !== 'image') missing.push('A capa saiu da pasta ou ainda não terminou de subir.');
  }
  const open = content.tasks.filter((task) => task.status !== 'approved').length;
  if (open === 1) missing.push('Falta aprovar 1 subtarefa.');
  if (open > 1) missing.push(`Faltam aprovar ${open} subtarefas.`);
  return missing;
};

export const REASON_REQUIRED = 'Informe o motivo da aprovação.';

/** The reason, by the contract's own rule; the words are the screen's. */
export const reasonIssue = (value: string): string | undefined => {
  if (ContentReasonSchema.safeParse(value).success) return undefined;
  return value.trim() === '' ? REASON_REQUIRED : 'O motivo tem caracteres que não são aceitos, ou passa de 5000 bytes.';
};

const FAILED: Readonly<Record<ContentAction, string>> = {
  submit: 'Não foi possível enviar o conteúdo para aprovação. Tente de novo.',
  approve: 'Não foi possível registrar a aprovação. Tente de novo.',
  publish: 'Não foi possível marcar o conteúdo como publicado. Tente de novo.',
  unpublish: 'Não foi possível desfazer a publicação. Tente de novo.',
  cancel: 'Não foi possível cancelar o conteúdo. Tente de novo.',
  reschedule: 'Não foi possível reagendar o conteúdo. Tente de novo.'
};

const STATE: Readonly<Record<ContentAction, string>> = {
  submit: 'Só um conteúdo em produção ou em ajuste é enviado para aprovação. Feche e abra de novo para ver o estado atual.',
  approve: 'Só um conteúdo aguardando aprovação é aprovado. Feche e abra de novo para ver o estado atual.',
  publish: 'Só um conteúdo pronto para publicar é marcado como publicado. Feche e abra de novo para ver o estado atual.',
  unpublish: 'Só um conteúdo publicado volta a pronto para publicar. Feche e abra de novo para ver o estado atual.',
  cancel: 'Um conteúdo publicado não é cancelado. Feche e abra de novo para ver o estado atual.',
  reschedule: 'Só um conteúdo cancelado é reagendado. Feche e abra de novo para ver o estado atual.'
};

/** The screen's own words for each refusal of a move: what the server wrote is never shown. */
export const actionRefusal = (error: unknown, action: ContentAction): string => {
  if (error instanceof HttpClientError) {
    const { status, code } = error;
    if (status === 409 && code === 'CONTENT_STATE') return STATE[action];
    if (status === 409 && code === 'CONTENT_REVISION_CHANGED') return 'O conteúdo mudou desde que você o abriu. Feche, abra de novo e confira antes de aprovar.';
    if (status === 409 && code === 'CONTENT_UNPUBLISH_EXPIRED') return 'A publicação só se desfaz no dia em que foi marcada.';
    if (status === 409 && code === 'CONTENT_TASKS_NOT_APPROVED') return 'Todas as subtarefas precisam estar aprovadas antes do envio.';
    if (status === 409 && code === 'CONTENT_MEDIA_NOT_CONFIRMED') return 'O conteúdo tem mídia que ainda não terminou de subir. Espere o envio terminar ou troque a mídia.';
    if (status === 409 && code === 'CONTENT_MEDIA_INCOMPLETE') return 'A mídia ou a capa não está completa para este formato: falta mídia, ou a mídia ou a capa saiu da pasta.';
    if (status === 409 && code === 'CLIENT_ARCHIVED') return 'Este cliente está arquivado: o conteúdo é só leitura.';
    if (status === 409 && code === 'TRY_AGAIN') return 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.';
    if (status === 400 && code === 'CONTENT_PUBLISHED_ON_INVALID') return 'A data real da publicação não pode ser futura.';
    if (status === 400 && code === 'CONTENT_REASON_INVALID') return 'O motivo da aprovação não foi aceito. Revise o texto.';
    if (status === 403) return 'Você não tem permissão para esta ação.';
    if (status === 404) return 'Este conteúdo não existe mais.';
  }
  return FAILED[action];
};
