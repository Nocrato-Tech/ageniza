import type { ContentFormat, ContentListItem, ContentStatus } from '@ageniza/contracts';

import { daysBetween } from './content-dates.js';

/** In the agency, "aprovado" reads "Pronto para publicar" (specs/conteudo.md section 4). */
export const STATUS_LABELS: Readonly<Record<ContentStatus, string>> = {
  in_production: 'Em produção',
  awaiting_approval: 'Aguardando aprovação',
  adjusting: 'Em ajuste',
  approved: 'Pronto para publicar',
  published: 'Publicado',
  cancelled: 'Cancelado'
};

export const FORMAT_LABELS: Readonly<Record<ContentFormat, string>> = {
  image: 'Imagem',
  carousel: 'Carrossel',
  reels: 'Reels',
  long_video: 'Vídeo longo',
  vsl: 'VSL'
};

/** A published or cancelled content has no deadline left, and it cannot be moved either (specs/conteudo.md section 4). */
export const isClosed = (status: ContentStatus): boolean => status === 'published' || status === 'cancelled';

export type DeadlineAlert = 'overdue' | 'due-soon' | null;

/**
 * Derived, never stored: a planned day already past is overdue, and one within two days (today
 * included) is about to be. Closed contents have neither (specs/conteudo.md section 4).
 */
export const deadlineAlert = (content: Pick<ContentListItem, 'publishOn' | 'status'>, today: string): DeadlineAlert => {
  if (isClosed(content.status)) return null;
  const days = daysBetween(today, content.publishOn);
  if (days < 0) return 'overdue';
  return days <= 2 ? 'due-soon' : null;
};

export const DEADLINE_LABELS: Readonly<Record<Exclude<DeadlineAlert, null>, string>> = {
  overdue: 'Atrasado',
  'due-soon': 'Prazo em dois dias'
};

/** Whole percent of approved subtasks; nothing without subtasks, so no "0%" over an empty list. */
export const subtaskPercent = (content: Pick<ContentListItem, 'tasksApproved' | 'tasksTotal'>): number | null =>
  content.tasksTotal === 0 ? null : Math.round((content.tasksApproved / content.tasksTotal) * 100);
