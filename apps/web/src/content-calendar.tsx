import { useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { ContentListItem } from '@ageniza/contracts';
import { FormatTag, LateBadge, Popover, StatusTag, type PopoverPlacement } from '@ageniza/ui';

import { useContentsAddress } from './content-address.js';
import { ContentHoverCard } from './content-card-extras.js';
import { ContentCover } from './content-cover.js';
import { fullDayLabel, WEEKDAY_LABELS, type CalendarView } from './content-dates.js';
import { DEADLINE_LABELS, deadlineAlert, FORMAT_LABELS, FORMAT_TONES, isClosed, STATUS_LABELS, STATUS_TAGS, subtaskPercent } from './content-labels.js';

/**
 * Where the hover card opens, so it faces the inside of the grid: the last two columns (sábado and domingo) open to the
 * left, and the last row open upwards (a week is one row, so it opens upwards whole).
 */
export const hoverPlacement = (index: number, total: number): PopoverPlacement =>
  `${index >= total - 7 ? 'top' : 'bottom'}-${index % 7 >= 5 ? 'end' : 'start'}`;

/**
 * The card of the calendar (`specs/conteudo.md` section 7). Every string that came from the server
 * is a React text child, never markup. A card is draggable only when the caller says it can move and
 * the content is still open: a published or cancelled one never changes date (specs/conteudo.md section 4).
 * Resting the mouse on it, or focusing it, opens the floating card; a touch never does.
 */
export function ContentCard({ content, clientId, today, placement = 'bottom-start', draggable = false, busy = false, onDragStart, onDragEnd }: {
  content: ContentListItem;
  clientId: string;
  today: string;
  placement?: PopoverPlacement;
  draggable?: boolean;
  busy?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}) {
  const alert = deadlineAlert(content, today);
  const percent = subtaskPercent(content);
  const address = useContentsAddress(clientId);
  const location = useLocation();
  // A card being dragged keeps the floating card closed, or it would hang over the day it is dropped on.
  const [grabbed, setGrabbed] = useState(false);
  return <Popover
    className="content-card-anchor"
    label={`Detalhes de ${content.title}`}
    openOn="hover"
    strategy="fixed"
    placement={placement}
    disabled={grabbed}
    trigger={(hover) => <article
      className={`content-card${draggable ? ' content-card--movable' : ''}${busy ? ' content-card--busy' : ''}`}
      data-status={content.status}
      data-format={FORMAT_TONES[content.format]}
      data-late={alert === 'overdue' || undefined}
      draggable={draggable}
      tabIndex={0}
      aria-busy={busy || undefined}
      onDragStart={draggable ? (event) => { setGrabbed(true); onDragStart?.(event); } : undefined}
      onDragEnd={draggable ? () => { setGrabbed(false); onDragEnd?.(); } : undefined}
    >
      <ContentCover assetId={content.thumbnailAssetId} format={content.format} bare={content.thumbnailAssetId === null} />
      <p className="content-card__title">
        <span className="content-card__prefix">{FORMAT_LABELS[content.format]}: </span>
        {/* A link is draggable by itself: without this the drag of the card would carry the address instead of the card. */}
        <Link
          className="content-card__link"
          draggable={false}
          to={{ pathname: `${address}/${content.id}`, search: location.search }}
          state={location.state}
          aria-expanded={hover['aria-expanded']}
          aria-controls={hover['aria-controls']}
          aria-haspopup={hover['aria-haspopup']}
        >{content.title}</Link>
      </p>
      {content.publishAtTime !== null && <p className="content-card__meta">{content.publishAtTime}</p>}
      <ul className="content-card__badges">
        <li><FormatTag format={FORMAT_TONES[content.format]}>{FORMAT_LABELS[content.format]}</FormatTag></li>
        {alert === 'overdue' && <li className="content-card__badge--overdue"><LateBadge>{DEADLINE_LABELS.overdue}</LateBadge></li>}
        <li><StatusTag status={STATUS_TAGS[content.status]}>{STATUS_LABELS[content.status]}</StatusTag></li>
        {alert === 'due-soon' && <li className="content-card__badge content-card__badge--due-soon">{DEADLINE_LABELS['due-soon']}</li>}
        {percent !== null && <li className="content-card__badge">{percent}% das subtarefas</li>}
      </ul>
    </article>}
  >
    <ContentHoverCard content={content} clientId={clientId} movable={draggable} />
  </Popover>;
}

export interface ContentCalendarProps {
  readonly clientId: string;
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
  /** What a day carries besides its contents (the story scripts: the "+" and a mark for each script). */
  readonly dayExtras?: (day: string) => ReactNode;
}

/** Whole weeks, Monday first: a month and a week are the same grid with a different number of rows. */
export function ContentCalendar({ clientId, view, anchor, today, days, contents, canMove = false, movingId = null, onMove, dayExtras }: ContentCalendarProps) {
  // Which card is being dragged lives here, not in the data transfer: a drop that was not started by a card of this calendar moves nothing.
  const [dragging, setDragging] = useState<ContentListItem | null>(null);
  const byDay = new Map<string, ContentListItem[]>();
  for (const content of contents) byDay.set(content.publishOn, [...(byDay.get(content.publishOn) ?? []), content]);

  return <div className="content-calendar" data-view={view}>
    <ol className="content-calendar__weekdays" aria-hidden="true">
      {WEEKDAY_LABELS.map((label) => <li key={label}>{label}</li>)}
    </ol>
    <ol className="content-calendar__days">
      {days.map((day, dayIndex) => {
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
          {dayExtras?.(day)}
          {items.length > 0 && <ul className="content-day__items">
            {items.map((content) => <li key={content.id}>
              <ContentCard
                content={content}
                clientId={clientId}
                today={today}
                placement={hoverPlacement(dayIndex, days.length)}
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
