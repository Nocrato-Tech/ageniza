import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { Button, IconButton } from './button.js';
import { addDays, addMonths, fromTyped, fullDay, maskTyped, monthGrid, monthTitle, toTyped, weekdayIndex } from './calendar-days.js';
import type { FieldControlProps } from './field.js';
import { IconSlot } from './icon.js';
import { placeFloating, type Placed } from './popover-position.js';

const WEEKDAY_HEADS = [['seg', 'segunda-feira'], ['ter', 'terça-feira'], ['qua', 'quarta-feira'], ['qui', 'quinta-feira'], ['sex', 'sexta-feira'], ['sáb', 'sábado'], ['dom', 'domingo']] as const;

export interface DatePickerProps extends Partial<FieldControlProps> {
  /** `YYYY-MM-DD`, or empty when no day is chosen. */
  value: string;
  /** Gets the day as `YYYY-MM-DD`, or `''` while what was typed is not yet a whole, real day. */
  onChange: (value: string) => void;
  /** The business day to mark "hoje" and to open on when nothing is chosen. The caller owns the time zone. */
  today: string;
  /** Days outside `min` and `max` (inclusive) cannot be picked from the calendar; a typed one is for the caller's validation to refuse. */
  min?: string;
  max?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
  /** Names the button that opens the calendar. */
  toggleLabel?: string;
}

const clampDay = (day: string, min: string | undefined, max: string | undefined): string => {
  if (min !== undefined && day < min) return min;
  if (max !== undefined && day > max) return max;
  return day;
};

/**
 * A day field: the day is typed as `dd/mm/aaaa` or picked on a calendar with room to press (44 px cells). The calendar
 * is a grid with the arrow keys, Home and End, Page Up and Page Down; Esc closes only the calendar, even inside a dialog.
 * `value` and `onChange` are always `YYYY-MM-DD`.
 */
export function DatePicker({
  value, onChange, today, min, max, name, disabled = false, className, toggleLabel = 'Abrir calendário', id, 'aria-describedby': describedBy, 'aria-invalid': invalid, 'aria-busy': busy
}: DatePickerProps) {
  const [draft, setDraft] = useState(() => toTyped(value));
  const [seen, setSeen] = useState(value);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState('');
  const [placed, setPlaced] = useState<Placed | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const panelId = useId();
  const hintId = useId();
  const titleId = useId();

  // A value that changes from outside (a reset, the calendar) rewrites the text; one that only echoes the text leaves it alone.
  if (value !== seen) {
    setSeen(value);
    if (fromTyped(draft) !== value) setDraft(toTyped(value));
  }

  const month = (focused === '' ? today : focused).slice(0, 7);
  const inRange = (day: string): boolean => (min === undefined || day >= min) && (max === undefined || day <= max);

  const openCalendar = (): void => {
    const typed = fromTyped(draft);
    setFocused(clampDay(typed === '' ? today : typed, min, max));
    focusDay.current = true;
    setOpen(true);
  };

  const closeCalendar = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  };

  const pick = (day: string): void => {
    onChange(day);
    closeCalendar(true);
  };

  useLayoutEffect(() => {
    if (!open || !focusDay.current) return;
    focusDay.current = false;
    panelRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${focused}"]`)?.focus();
  });

  useLayoutEffect(() => {
    if (!open) {
      setPlaced(null);
      return;
    }
    const anchor = wrapperRef.current?.getBoundingClientRect();
    const card = panelRef.current?.getBoundingClientRect();
    if (anchor === undefined || card === undefined) return;
    setPlaced(placeFloating(anchor, card, { width: window.innerWidth, height: window.innerHeight }, 'bottom-start', 8, 8));
  }, [open, month]);

  useEffect(() => {
    if (!open) return;
    // The card sits on the screen, not inside a scrolling ancestor, so a scroll or resize of the page would leave it behind.
    const away = (event: Event): void => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const onType = (raw: string): void => {
    const masked = maskTyped(raw);
    const day = fromTyped(masked);
    setDraft(day === '' ? masked : toTyped(day));
    onChange(day);
  };

  const move = (to: string): void => {
    focusDay.current = true;
    setFocused(clampDay(to, min, max));
  };

  const shift = (months: number): void => setFocused(clampDay(addMonths(focused, months), min, max));

  const onGridKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      // Without this the dialog around the field would take the same Esc and close with the calendar.
      event.preventDefault();
      event.stopPropagation();
      closeCalendar(true);
      return;
    }
    const keys: Record<string, string> = {
      ArrowLeft: addDays(focused, -1),
      ArrowRight: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      Home: addDays(focused, -weekdayIndex(focused)),
      End: addDays(focused, 6 - weekdayIndex(focused)),
      PageUp: addMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: addMonths(focused, event.shiftKey ? 12 : 1)
    };
    const target = keys[event.key];
    if (target === undefined || !(event.target instanceof HTMLButtonElement) || event.target.dataset.day === undefined) return;
    event.preventDefault();
    move(target);
  };

  const onBlur = (event: FocusEvent): void => {
    // Focus that goes nowhere (a press on the panel's padding) keeps it open; focus that lands outside closes it.
    if (open && event.relatedTarget instanceof Node && !wrapperRef.current?.contains(event.relatedTarget)) setOpen(false);
  };

  const grid = monthGrid(`${month}-01`);
  const monthStart = `${month}-01`;
  const style: CSSProperties | undefined = placed === null ? undefined : { '--ui-date-top': `${placed.top}px`, '--ui-date-left': `${placed.left}px` } as CSSProperties;
  const todayInRange = inRange(today);

  return (
    <div ref={wrapperRef} className={['ui-date-picker', className].filter(Boolean).join(' ')} onBlur={onBlur}>
      <div className="ui-date-picker__field">
        <input
          id={id}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="dd/mm/aaaa"
          maxLength={10}
          className="ui-text-input ui-date-picker__input"
          value={draft}
          disabled={disabled}
          aria-describedby={[describedBy, hintId].filter(Boolean).join(' ')}
          aria-invalid={invalid}
          aria-busy={busy}
          onChange={(event) => onType(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); openCalendar(); } }}
        />
        <button
          ref={toggleRef}
          type="button"
          className="ui-date-picker__toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={disabled}
          onClick={() => (open ? closeCalendar(false) : openCalendar())}
        >
          <IconSlot><CalendarDays /></IconSlot>
        </button>
      </div>
      <p id={hintId} className="ui-date-picker__hint">Digite o dia como dia/mês/ano ou abra o calendário.</p>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className="ui-date-picker__panel"
          tabIndex={-1}
          style={style}
          onKeyDown={onGridKey}
        >
          <div className="ui-date-picker__head">
            <IconButton label="Mês anterior" icon={<ChevronLeft />} onClick={() => shift(-1)} />
            <h2 id={titleId} className="ui-date-picker__title" aria-live="polite">{monthTitle(monthStart)}</h2>
            <IconButton label="Próximo mês" icon={<ChevronRight />} onClick={() => shift(1)} />
          </div>
          <table className="ui-date-picker__grid" role="grid" aria-labelledby={titleId}>
            <thead>
              <tr>
                {WEEKDAY_HEADS.map(([short, long]) => <th key={short} scope="col"><abbr title={long}>{short}</abbr></th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }, (_row, row) => (
                <tr key={grid[row * 7]}>
                  {grid.slice(row * 7, row * 7 + 7).map((day) => {
                    const selected = day === value;
                    const enabled = inRange(day);
                    return (
                      <td key={day} role="gridcell" aria-selected={selected}>
                        <button
                          type="button"
                          data-day={day}
                          tabIndex={day === focused ? 0 : -1}
                          disabled={!enabled}
                          aria-label={fullDay(day)}
                          aria-current={day === today ? 'date' : undefined}
                          className={['ui-date-picker__day', day.slice(0, 7) !== month && 'ui-date-picker__day--outside'].filter(Boolean).join(' ')}
                          onClick={() => pick(day)}
                        >
                          {Number(day.slice(8, 10))}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ui-date-picker__foot">
            {todayInRange && <Button variant="ghost" onClick={() => pick(today)}>Hoje</Button>}
            <Button variant="secondary" onClick={() => closeCalendar(true)}>Fechar</Button>
          </div>
        </div>
      )}
    </div>
  );
}
