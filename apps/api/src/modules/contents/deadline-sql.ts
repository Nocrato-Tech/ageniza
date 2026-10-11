import { CONTENT_DEADLINE_OPEN_STATUSES, CONTENT_DUE_SOON_DAYS } from '@ageniza/contracts';

/**
 * The SQL of the one definition of "atrasado" and "prazo em dois dias" (`contentDeadline`, packages/contracts), for a query over
 * `public.contents` aliased `content`. `today` is an SQL expression of the day in America/Sao_Paulo, repeated where the definition
 * needs it (so the caller binds as many times as `today` carries `?`). The statuses and the window come from the contract, never
 * from a literal here, and they are constants of the code, not input.
 */
export const contentDeadlineSql = (today: string) => ({
  openStatuses: CONTENT_DEADLINE_OPEN_STATUSES.map((status) => `'${status}'`).join(', '),
  overdue: `content.publish_on < ${today}`,
  dueSoon: `content.publish_on between ${today} and ${today} + ${CONTENT_DUE_SOON_DAYS}`
});
