import { useState, type DragEvent } from 'react';

import type { ContentListItem } from '@ageniza/contracts';

import { fullDayLabel, WEEKDAY_LABELS, type CalendarView } from './content-dates.js';
import { DEADLINE_LABELS, deadlineAlert, FORMAT_LABELS, isClosed, STATUS_LABELS, subtaskPercent } from './content-labels.js';

/**
 * The card of the calendar (`specs/conteudo.md` section 7). Every string that came from the server
 * is a React text child, never markup. A card is draggable only when the caller says it can move and
 * the content is still open: a published or cancelled one never changes date (specs/conteudo.md section 4).
 */
export function ContentCard({ content, today, draggable = false, busy = false, onDragStart, onDragEnd }: {
  content: ContentListItem;
  today: string;
  draggable?: boolean;
  busy?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}) {
  const alert = deadlineAlert(content, today);
  const percent = subtaskPercent(content);
  return <article
    className={`content-card${draggable ? ' content-card--movable' : ''}${busy ? ' content-card--busy' : ''}`}
    data-status={content.status}
    draggable={draggable}
    aria-busy={busy || undefined}
    onDragStart={draggable ? onDragStart : undefined}
    onDragEnd={draggable ? onDragEnd : undefined}
  >
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
  /** Whether the person may move a content at all (permission, and a client that is not archived). */
  readonly canMove?: boolean;
  /** The content being moved: it and every other card wait for the answer. */
  readonly movingId?: string | null;
  readonly onMove?: (content: ContentListItem, day: string) => void;
}

/** Whole weeks, Monday first: a month and a week are the same grid with a different number of rows. */
export function ContentCalendar({ view, anchor, today, days, contents, canMove = false, movingId = null, onMove }: ContentCalendarProps) {
  // Which card is being dragged lives here, not in the data transfer: a drop that was not started by a card of this calendar moves nothing.
  const [dragging, setDragging] = useState<ContentListItem | null>(null);
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
          data-day={day}
          onDragOver={(event) => { if (dragging !== null) event.preventDefault(); }}
          onDrop={(event) => {
            if (dragging === null) return;
            event.preventDefault();
            const moved = dragging;
            setDragging(null);
            if (moved.publishOn !== day) onMove?.(moved, day);
          }}
        >
          <p className="content-day__number">
            <time dateTime={day}>
              <span aria-hidden="true">{Number(day.slice(8, 10))}</span>
              <span className="visually-hidden">{fullDayLabel(day)}</span>
            </time>
          </p>
          {items.length > 0 && <ul className="content-day__items">
            {items.map((content) => <li key={content.id}>
              <ContentCard
                content={content}
                today={today}
                draggable={canMove && movingId === null && !isClosed(content.status)}
                busy={movingId === content.id}
                onDragStart={(event) => {
                  event.dataTransfer?.setData('text/plain', content.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                  setDragging(content);
                }}
                onDragEnd={() => setDragging(null)}
              />
            </li>)}
          </ul>}
        </li>;
      })}
    </ol>
  </div>;
}
