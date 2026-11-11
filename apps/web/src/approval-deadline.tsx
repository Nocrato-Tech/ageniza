import { CircleAlert, Clock } from 'lucide-react';

import { CalendarDaySchema, type PortalContentApproval } from '@ageniza/contracts';

import { daysBetween, dayMonthLabel, fullDayLabel, todayInSaoPaulo, weekdayShortLabel } from './content-dates.js';

/**
 * The deadline of an approval round (decision 2026-11-10): "vence" and "venceu" are its words. "Atrasado" and "prazo em dois dias"
 * belong to the day of the publication, so they never appear here.
 */

const days = (count: number): string => `${count} ${count === 1 ? 'dia' : 'dias'}`;

/** From the days until the deadline, negative once it has passed: "vence hoje", "vence amanhã", "vence em 5 dias", "venceu há 2 dias". */
export const deadlineWording = (daysToDue: number): string => {
  if (daysToDue < 0) return `venceu há ${days(-daysToDue)}`;
  if (daysToDue === 0) return 'vence hoje';
  if (daysToDue === 1) return 'vence amanhã';
  return `vence em ${days(daysToDue)}`;
};

/** What a content without a deadline says instead: how long ago it was sent. */
export const waitingWording = (daysWaiting: number): string => (daysWaiting === 0 ? 'enviado hoje' : `enviado há ${days(daysWaiting)}`);

/** "sex, 14/11": the day of the deadline as the client reads it, from the text and never from a `Date`. */
export const dueDayLabel = (day: string): string => `${weekdayShortLabel(day)}, ${dayMonthLabel(day)}`;

/**
 * The state of the wait for the agency: the deadline when there is one, else how long the content has been waiting, else nothing
 * (a content sent before the rounds has neither date). The server counts both in the São Paulo day; the screen only words them.
 */
export function AwaitingState({ daysToDue, daysWaiting }: { daysToDue: number | null; daysWaiting: number | null }) {
  if (daysToDue !== null) {
    const expired = daysToDue < 0;
    return <span className={['approval-state', expired && 'approval-state--expired'].filter(Boolean).join(' ')}>
      <span className="ui-icon" aria-hidden="true">{expired ? <CircleAlert /> : <Clock />}</span>
      {deadlineWording(daysToDue)}
    </span>;
  }
  if (daysWaiting === null) return null;
  return <span className="approval-state">
    <span className="ui-icon" aria-hidden="true"><Clock /></span>
    {waitingWording(daysWaiting)}
  </span>;
};

/**
 * What the agency asked of the client, on the portal and on the approval link: until when, and the note, signed by the agency.
 * A round with neither says nothing. The note is the agency's text and is drawn as a text child, never as markup.
 */
export function ApprovalRound({ approval, agencyName, showNote = true, today = todayInSaoPaulo() }: {
  approval: PortalContentApproval | null;
  /** Signs the note; leave it out where the note is not shown. */
  agencyName?: string;
  showNote?: boolean;
  today?: string;
}) {
  if (approval === null) return null;
  const { note } = approval;
  const dueOn = approval.dueOn !== null && CalendarDaySchema.safeParse(approval.dueOn).success ? approval.dueOn : null;
  const withNote = showNote && note !== null && note !== '';
  if (dueOn === null && !withNote) return null;
  return <div className="approval-round">
    {dueOn !== null && <p className="approval-round__due">
      <span className="ui-icon" aria-hidden="true"><Clock /></span>
      <span>Aprovar até <time dateTime={dueOn} title={fullDayLabel(dueOn)}>{dueDayLabel(dueOn)}</time> · {deadlineWording(daysBetween(today, dueOn))}</span>
    </p>}
    {withNote && <div className="approval-round__note">
      <p className="approval-round__author">{agencyName === undefined ? 'Recado da agência' : `Recado de ${agencyName}`}</p>
      <p className="approval-round__text">{note}</p>
    </div>}
  </div>;
}
