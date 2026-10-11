import type { ReactNode } from 'react';

import type { ContentListItem } from '@ageniza/contracts';

import { fullDayLabel, WEEKDAY_LABELS, type CalendarView } from './content-dates.js';
import { DEADLINE_LABELS, deadlineAlert, FORMAT_LABELS, STATUS_LABELS, subtaskPercent } from './content-labels.js';

/**
 * The card of the calendar (`specs/conteudo.md` section 7). Every string that came from the server
 * is a React text child, never markup. The cover, the hover detail and the drag belong to the next
 * part of #262.
 */
export function ContentCard({ content, today }: { content: ContentListItem; today: string }) {
  const alert = deadlineAlert(content, today);
  const percent = subtaskPercent(content);
  return <article className="content-card" data-status={content.status}>
    <p className="content-card__title">{content.title}</p>
    <p className="content-card__meta">
      {FORMAT_LABELS[content.format]}{content.publishAtTime !== null && <> · {content.publishAtTime}</>}
    </p>
    <ul className="content-card__badges">
      <li className="content-card__badge">{STATUS_LABELS[content.status]}</li>
      {alert !== null && <li className={`content-card__badge content-card__badge--${alert}`}>{DEADLINE_LABELS[alert]}</li>}
      {percent !== null && <li className="content-card__badge">{percent}% das subtarefas</li>}
    </ul>
  </article>;
}

export interface ContentCalendarProps {
  readonly view: CalendarView;
  /** The day the period is built around; a month view dims the days of its neighbours. */
  readonly anchor: string;
  readonly today: string;
  readonly days: readonly string[];
  readonly contents: readonly ContentListItem[];
  /** What a day carries besides its contents (the story scripts: the "+" and a mark for each script). */
  readonly dayExtras?: (day: string) => ReactNode;
}

/** Whole weeks, Monday first: a month and a week are the same grid with a different number of rows. */
export function ContentCalendar({ view, anchor, today, days, contents, dayExtras }: ContentCalendarProps) {
  const byDay = new Map<string, ContentListItem[]>();
  for (const content of contents) byDay.set(content.publishOn, [...(byDay.get(content.publishOn) ?? []), content]);

  return <div className="content-calendar" data-view={view}>
    <ol className="content-calendar__weekdays" aria-hidden="true">
      {WEEKDAY_LABELS.map((label) => <li key={label}>{label}</li>)}
    </ol>
    <ol className="content-calendar__days">
      {days.map((day) => {
        const outside = view === 'month' && day.slice(0, 7) !== anchor.slice(0, 7);
        const items = byDay.get(day) ?? [];
        return <li
          key={day}
          className={`content-day${outside ? ' content-day--outside' : ''}${day === today ? ' content-day--today' : ''}`}
          aria-current={day === today ? 'date' : undefined}
        >
          <p className="content-day__number">
            <time dateTime={day}>
              <span aria-hidden="true">{Number(day.slice(8, 10))}</span>
              <span className="visually-hidden">{fullDayLabel(day)}</span>
            </time>
          </p>
          {dayExtras?.(day)}
          {items.length > 0 && <ul className="content-day__items">
            {items.map((content) => <li key={content.id}><ContentCard content={content} today={today} /></li>)}
          </ul>}
        </li>;
      })}
    </ol>
  </div>;
}
