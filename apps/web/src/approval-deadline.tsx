import { useEffect, useState } from 'react';
import { CircleAlert, Clock } from 'lucide-react';

import { CalendarDaySchema, PORTAL_SENDER_PHOTO_PATH, type PortalContentApproval } from '@ageniza/contracts';
import { Avatar } from '@ageniza/ui';

import { daysBetween, dayMonthLabel, fullDayLabel, shortDayLabel, todayInSaoPaulo, weekdayShortLabel } from './content-dates.js';
import { clockLabel, instantLabel } from './home-dates.js';
import { useApiClient } from './http.js';

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

const WEEKDAY_NAMES: Readonly<Record<string, string>> = {
  dom: 'domingo', seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', 'sáb': 'sábado'
};

/** "quinta, 12 nov": the weekday and the day as the board writes them, from the text and never from a `Date`. */
export const spokenDayLabel = (day: string): string => `${WEEKDAY_NAMES[weekdayShortLabel(day)] ?? ''}, ${shortDayLabel(day)}`;

/** "na sexta" or "no sábado": the article of the weekday, for "publica na sexta, 13 nov". */
export const weekdayArticle = (day: string): 'na' | 'no' => {
  const weekday = weekdayShortLabel(day);
  return weekday === 'sáb' || weekday === 'dom' ? 'no' : 'na';
};

/** "12h" or "18h30" from the `HH:MM` the content carries. */
export const hourLabel = (time: string): string => {
  const [hour = '', minute = '00'] = time.split(':');
  return minute === '00' ? `${Number(hour)}h` : `${Number(hour)}h${minute}`;
};

/** From the days until the deadline: "Falta 1 dia", "Faltam 5 dias", "Vence hoje", "Venceu há 2 dias". */
const remainingWording = (daysToDue: number): string => {
  if (daysToDue < 0) return `Venceu há ${days(-daysToDue)}`;
  if (daysToDue === 0) return 'Vence hoje';
  return daysToDue === 1 ? 'Falta 1 dia' : `Faltam ${days(daysToDue)}`;
};

/** "Responda até quinta, 12 nov, 18h" and how long is left, in the day and the clock of São Paulo. */
export function ApprovalDeadline({ approval, today = todayInSaoPaulo() }: { approval: PortalContentApproval | null; today?: string }) {
  const dueOn = approval?.dueOn ?? null;
  if (approval === null || dueOn === null || !CalendarDaySchema.safeParse(dueOn).success) return null;
  const left = daysBetween(today, dueOn);
  return <div className={['approval-deadline', left < 0 && 'approval-deadline--expired'].filter(Boolean).join(' ')}>
    <span className="ui-icon" aria-hidden="true">{left < 0 ? <CircleAlert /> : <Clock />}</span>
    <div>
      <p className="approval-deadline__big">Responda até <time dateTime={approval.dueAt ?? dueOn}>{spokenDayLabel(dueOn)}{approval.dueAt !== null && `, ${clockLabel(approval.dueAt)}`}</time></p>
      <p className="approval-deadline__left">{remainingWording(left)}</p>
    </div>
  </div>;
}

/** The photo is shown only once the portal's route has answered it: a person without one, or a refusal, keeps the initials. */
function useLoadedPhoto(src: string | null): string | null {
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (src === null) return undefined;
    const image = new Image();
    image.onload = () => { setLoaded(src); };
    image.src = src;
    return () => { image.onload = null; };
  }, [src]);
  return loaded === src ? src : null;
}

/** "9 de novembro, 17h08": the São Paulo day and clock of an instant, never "agora". */
const sentLabel = (at: string): string => `${instantLabel(at, Number.POSITIVE_INFINITY)}, ${clockLabel(at)}`;

/**
 * The agency's note with who sent the round ("Recado de João Pereira, da Agência Horizonte"), the person's photo from the portal's own
 * route and the day it was sent. The note is the agency's text and is drawn as a text child, never as markup.
 */
export function ApprovalSenderNote({ approval, agencyName }: { approval: PortalContentApproval | null; agencyName: string }) {
  const httpClient = useApiClient();
  const sender = approval?.sentBy ?? null;
  const path = sender?.photoUrl != null && PORTAL_SENDER_PHOTO_PATH.test(sender.photoUrl) ? sender.photoUrl : null;
  const photo = useLoadedPhoto(path === null ? null : httpClient.browserUrl(path));
  const note = approval?.note ?? null;
  if (approval === null || note === null || note === '') return null;
  return <div className="approval-sender">
    {sender !== null && <Avatar name={sender.name} photoUrl={photo} size="sm" tone="violet" />}
    <div className="approval-sender__body">
      <p className="approval-sender__who">{sender === null ? `Recado de ${agencyName}` : `Recado de ${sender.name}, da ${agencyName}`}</p>
      <p className="approval-sender__text">{note}</p>
      {approval.sentAt !== null && <p className="approval-sender__when">{sentLabel(approval.sentAt)}</p>}
    </div>
  </div>;
}
