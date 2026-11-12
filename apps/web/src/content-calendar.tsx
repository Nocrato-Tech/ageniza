import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

import type { ContentListItem } from '@ageniza/contracts';
import { LateBadge, Popover, StatusTag, type PopoverPlacement } from '@ageniza/ui';

import { useContentsAddress } from './content-address.js';
import { ContentHoverCard } from './content-card-extras.js';
import { ContentCover, FORMAT_ICONS } from './content-cover.js';
import { addDays, dayOfMonthLabel, fullDayLabel, saoPauloClock, WEEKDAY_HEADERS, weekdayShortLabel, type CalendarView } from './content-dates.js';
import { deadlineAlert, DEADLINE_LABELS, DISPLAY_LABELS, DISPLAY_TAGS, displayState, FORMAT_LABELS, FORMAT_TONES, isClosed, type DisplayState } from './content-labels.js';

/**
 * Where the hover card opens, so it faces the inside of the grid: the last two columns (sexta and sábado) open to the
 * left, and the last row open upwards (a week is one row, so it opens upwards whole).
 */
export const hoverPlacement = (index: number, total: number): PopoverPlacement =>
  `${index >= total - 7 ? 'top' : 'bottom'}-${index % 7 >= 5 ? 'end' : 'start'}`;

/** How long a click that ends a drag is still ignored, in ms: the click some browsers fire on the card the drag started from. */
const DRAG_CLICK_GUARD = 60;

/**
 * The card of the calendar (`specs/conteudo.md` section 7), compact: the cover (the shape of the format without one), the
 * format, the title in up to two lines and one tag for the state. The whole card is the link to the content, so a press anywhere on it opens it; the keyboard has one stop
 * on it, named by what it shows. Every string that came from the server is a React text child, never markup. A card is
 * draggable only when the caller says it can move and the content is still open: a published or cancelled one never
 * changes date (specs/conteudo.md section 4). A drag never opens the content. Resting the mouse on it, or focusing it,
 * opens the floating card; a touch never does.
 */
export function ContentCard({ content, clientId, today, now, placement = 'bottom-start', draggable = false, busy = false, onDragStart, onDragEnd }: {
  content: ContentListItem;
  clientId: string;
  today: string;
  /** The day and time of São Paulo, for the states the hour decides ("agendado"); read from the clock when absent. */
  now?: { readonly day: string; readonly time: string };
  placement?: PopoverPlacement;
  draggable?: boolean;
  busy?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}) {
  const alert = deadlineAlert(content, today);
  const state: DisplayState = displayState(content, now ?? saoPauloClock());
  const address = useContentsAddress(clientId);
  const location = useLocation();
  const FormatIcon = FORMAT_ICONS[content.format];
  // A card being dragged keeps the floating card closed, or it would hang over the day it is dropped on.
  const [grabbed, setGrabbed] = useState(false);
  // A drag is not a press: the click that some browsers fire when it ends on the card it started from opens nothing.
  const justDragged = useRef(false);
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
      data-state={state}
      data-format={FORMAT_TONES[content.format]}
      data-late={alert === 'overdue' || undefined}
      draggable={draggable}
      aria-busy={busy || undefined}
      onDragStart={draggable ? (event) => { setGrabbed(true); onDragStart?.(event); } : undefined}
      onDragEnd={draggable
        ? () => {
          justDragged.current = true;
          setTimeout(() => { justDragged.current = false; }, DRAG_CLICK_GUARD);
          setGrabbed(false);
          onDragEnd?.();
        }
        : undefined}
    >
      {/* A link is draggable by itself: without `draggable={false}` the drag of the card would carry the address instead of the card. */}
      <Link
        className="content-card__link"
        draggable={false}
        to={{ pathname: `${address}/${content.id}`, search: location.search }}
        state={location.state}
        onClick={(event) => { if (justDragged.current) event.preventDefault(); }}
        aria-expanded={hover['aria-expanded']}
        aria-controls={hover['aria-controls']}
        aria-haspopup={hover['aria-haspopup']}
        aria-describedby={hover['aria-expanded'] ? hover['aria-controls'] : undefined}
      >
        <ContentCover assetId={content.thumbnailAssetId} format={content.format} className="content-card__cover" />
        <span className="content-card__body">
          <span className="content-card__support"><FormatIcon aria-hidden="true" />{content.publishAtTime === null ? FORMAT_LABELS[content.format] : `${FORMAT_LABELS[content.format]} · ${content.publishAtTime}`}</span>
          <span className="content-card__title">{content.title}</span>
        </span>
        <span className="content-card__foot">
          {state === 'late'
            ? <LateBadge>{DEADLINE_LABELS.overdue}</LateBadge>
            : <StatusTag status={DISPLAY_TAGS[state]}>{DISPLAY_LABELS[state]}</StatusTag>}
        </span>
      </Link>
    </article>}
  >
    <ContentHoverCard content={content} clientId={clientId} today={today} movable={draggable} />
  </Popover>;
}

/** A month cell shows this many cards; the rest is one "+N" away, so a crowded day never stretches its row. */
export const MONTH_DAY_LIMIT = 3;

export interface ContentCalendarProps {
  readonly clientId: string;
  readonly view: CalendarView;
  /** `grid` is the seven columns; `agenda` is one block per day, for a screen too narrow for the grid. */
  readonly layout?: 'grid' | 'agenda';
  /** The day the period is built around; a month view dims the days of its neighbours. */
  readonly anchor: string;
  readonly today: string;
  readonly now?: { readonly day: string; readonly time: string };
  readonly days: readonly string[];
  readonly contents: readonly ContentListItem[];
  /** Whether the person may move a content at all (permission, and a client that is not archived). */
  readonly canMove?: boolean;
  /** The content being moved: it and every other card wait for the answer. */
  readonly movingId?: string | null;
  readonly onMove?: (content: ContentListItem, day: string) => void;
  /** What a day carries besides its contents (the story scripts: the "+" and a mark for each script). */
  readonly dayExtras?: (day: string) => ReactNode;
  /** Opens the whole day (the week it belongs to): the "+N" of a crowded cell of the month. */
  readonly onOpenDay?: (day: string) => void;
}

const capitalized = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const groupByDay = (contents: readonly ContentListItem[]): Map<string, ContentListItem[]> => {
  const byDay = new Map<string, ContentListItem[]>();
  for (const content of contents) byDay.set(content.publishOn, [...(byDay.get(content.publishOn) ?? []), content]);
  return byDay;
};

/** Whole weeks, Sunday first: a month and a week are the same grid with a different number of rows. */
export function ContentCalendar({ clientId, view, layout = 'grid', anchor, today, now, days, contents, canMove = false, movingId = null, onMove, dayExtras, onOpenDay }: ContentCalendarProps) {
  // Which card is being dragged lives here, not in the data transfer: a drop that was not started by a card of this calendar moves nothing.
  const [dragging, setDragging] = useState<ContentListItem | null>(null);
  const byDay = groupByDay(contents);

  if (layout === 'agenda') {
    // A phone has no neighbours' days to show, and no drag: the date of a content is changed in its own detail.
    const shown = days.filter((day) => view === 'week' || day.slice(0, 7) === anchor.slice(0, 7));
    return <ol className="content-agenda" data-view={view}>
      {shown.map((day) => {
        const items = byDay.get(day) ?? [];
        return <li
          key={day}
          className={`content-agenda__day${day === today ? ' content-agenda__day--today' : ''}${items.length === 0 ? ' content-agenda__day--empty' : ''}`}
          aria-current={day === today ? 'date' : undefined}
          data-day={day}
        >
          <h3 className="content-agenda__label">
            <span className="content-agenda__when">{day === today ? 'Hoje' : day === addDays(today, 1) ? 'Amanhã' : capitalized(weekdayShortLabel(day))}</span>
            <time className="content-agenda__date" dateTime={day}>{dayOfMonthLabel(day)}</time>
          </h3>
          <div className="content-agenda__body">
            {items.length > 0 && <ul className="content-day__items">
              {items.map((content) => <li key={content.id}>
                <ContentCard content={content} clientId={clientId} today={today} now={now} placement="bottom-start" />
              </li>)}
            </ul>}
            {dayExtras?.(day)}
          </div>
        </li>;
      })}
    </ol>;
  }

  return <div className="content-calendar" data-view={view}>
    <ol className="content-calendar__weekdays" aria-hidden="true">
      {WEEKDAY_HEADERS.map((label) => <li key={label}>{label}</li>)}
    </ol>
    <ol className="content-calendar__days">
      {days.map((day, dayIndex) => {
        const outside = view === 'month' && day.slice(0, 7) !== anchor.slice(0, 7);
        const items = byDay.get(day) ?? [];
        const limited = view === 'month' && onOpenDay !== undefined && items.length > MONTH_DAY_LIMIT;
        const visible = limited ? items.slice(0, MONTH_DAY_LIMIT) : items;
        const hidden = items.length - visible.length;
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
            {visible.map((content) => <li key={content.id}>
              <ContentCard
                content={content}
                clientId={clientId}
                today={today}
                now={now}
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
            {hidden > 0 && <li>
              <button type="button" className="content-day__more" onClick={() => onOpenDay?.(day)}>
                +{hidden}<span className="visually-hidden"> {hidden === 1 ? 'conteúdo' : 'conteúdos'} em {fullDayLabel(day)}: abrir a semana</span>
              </button>
            </li>}
          </ul>}
        </li>;
      })}
    </ol>
  </div>;
}
