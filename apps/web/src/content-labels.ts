import { contentDeadline, type ContentDeadline, type ContentFormat, type ContentListItem, type ContentStatus } from '@ageniza/contracts';

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

export type DeadlineAlert = ContentDeadline | null;

/** Derived, never stored, and the definition is the contract's (`contentDeadline`), the same one the carteira counts in SQL (#549). */
export const deadlineAlert = (content: Pick<ContentListItem, 'publishOn' | 'status'>, today: string): DeadlineAlert => contentDeadline(content, today);

export const DEADLINE_LABELS: Readonly<Record<Exclude<DeadlineAlert, null>, string>> = {
  overdue: 'Atrasado',
  'due-soon': 'Prazo em dois dias'
};

/** Whole percent of approved subtasks; nothing without subtasks, so no "0%" over an empty list. */
export const subtaskPercent = (content: Pick<ContentListItem, 'tasksApproved' | 'tasksTotal'>): number | null =>
  content.tasksTotal === 0 ? null : Math.round((content.tasksApproved / content.tasksTotal) * 100);
