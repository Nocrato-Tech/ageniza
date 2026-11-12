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

/**
 * The SQL of "Agendado" (`contentIsScheduled`, packages/contracts), for a query over `public.contents` aliased `content`: approved, with a
 * publication hour that has not passed. `today` is the day of São Paulo and `localTime` the time of day there, both as SQL expressions of
 * the same instant; neither carries a time-zone name, since the database converts days with `app_private.sao_paulo_date` alone.
 */
export const contentScheduledSql = (today: string, localTime: string): string =>
  `(content.status = 'approved' and content.publish_at_time is not null and (content.publish_on > ${today} or (content.publish_on = ${today} and content.publish_at_time > ${localTime})))`;
