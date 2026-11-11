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

/**
 * "Agendado" is derived (decision 2026-11-11): an approved content with a publication hour whose instant, publishOn at publishAtTime in
 * America/Sao_Paulo, has not passed. Without an hour it stays "Aprovado"; once the instant passes it is "Aprovado" again. `now` is the day
 * and the time (`HH:MM:SS`) of America/Sao_Paulo at the same instant, so the comparison reads no time zone of its own.
 */
export const contentIsScheduled = (
  content: { readonly status: ContentStatus; readonly publishOn: string; readonly publishAtTime: string | null },
  now: { readonly day: string; readonly time: string }
): boolean => {
  if (content.status !== 'approved' || content.publishAtTime === null) return false;
  if (content.publishOn !== now.day) return content.publishOn > now.day;
  return `${content.publishAtTime}:00` > now.time;
};

/** How many days late a content is: the days since its publication day when that day is before `today`, else `null`. Only for the states that are still open. */
export const contentDaysLate = (content: { readonly status: ContentStatus; readonly publishOn: string }, today: string): number | null => {
  if (!(CONTENT_DEADLINE_OPEN_STATUSES as readonly ContentStatus[]).includes(content.status)) return null;
  const days = Math.round((dayMs(today) - dayMs(content.publishOn)) / DAY_MS);
  return days > 0 ? days : null;
};

/** `overdue` for a planned day before `today`, `due-soon` from `today` to `CONTENT_DUE_SOON_DAYS` days ahead, both ends in. */
export const contentDeadline = (content: { readonly status: ContentStatus; readonly publishOn: string }, today: string): ContentDeadline | null => {
  if (!(CONTENT_DEADLINE_OPEN_STATUSES as readonly ContentStatus[]).includes(content.status)) return null;
  const days = Math.round((dayMs(content.publishOn) - dayMs(today)) / DAY_MS);
  if (days < 0) return 'overdue';
  return days <= CONTENT_DUE_SOON_DAYS ? 'due-soon' : null;
};
