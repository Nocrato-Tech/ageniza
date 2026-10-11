import type { ContentStatus } from './contents.js';

/**
 * The one definition of "atrasado" and "prazo em dois dias" of a content (specs/conteudo.md section 4): derived from the planned day
 * and today in America/Sao_Paulo, never stored, and only for a content that is not published or cancelled. The carteira counts it in
 * SQL (`apps/api/src/modules/contents/deadline-sql.ts`, built from these constants) and the screens of Conteúdo read it through
 * `contentDeadline`; a test holds the two to the same answer.
 */
export const CONTENT_DEADLINE_OPEN_STATUSES = ['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const satisfies readonly ContentStatus[];

/** How many days after today, today included, a content is "about to be late". */
export const CONTENT_DUE_SOON_DAYS = 2;

export type ContentDeadline = 'overdue' | 'due-soon';

const DAY_MS = 86_400_000;
const dayMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

/** `overdue` for a planned day before `today`, `due-soon` from `today` to `CONTENT_DUE_SOON_DAYS` days ahead, both ends in. */
export const contentDeadline = (content: { readonly status: ContentStatus; readonly publishOn: string }, today: string): ContentDeadline | null => {
  if (!(CONTENT_DEADLINE_OPEN_STATUSES as readonly ContentStatus[]).includes(content.status)) return null;
  const days = Math.round((dayMs(content.publishOn) - dayMs(today)) / DAY_MS);
  if (days < 0) return 'overdue';
  return days <= CONTENT_DUE_SOON_DAYS ? 'due-soon' : null;
};
