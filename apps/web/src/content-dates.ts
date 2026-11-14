import { CalendarDaySchema } from '@ageniza/contracts';

/**
 * Calendar arithmetic on `YYYY-MM-DD` strings. A day is never read through the browser's time zone:
 * the agency's day is São Paulo's, and a `Date` built from local fields would flip it near midnight.
 * `Date.UTC` appears only to count days, never to tell which day it is.
 */
export type CalendarView = 'month' | 'week';

const DAY_MS = 86_400_000;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'] as const;
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'] as const;

export const WEEKDAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;

/** The header of the grid: the same weekdays, as the board spells them. */
export const WEEKDAY_HEADERS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

const toMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const todayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

/** The day (`YYYY-MM-DD`) and the time (`HH:MM:SS`) of an instant in the agency's time zone (`America/Sao_Paulo`). */
export const saoPauloClock = (now: Date = new Date()): { readonly day: string; readonly time: string } => {
  const parts = Object.fromEntries(todayFormatter.formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
};

/** Today in the agency's time zone (`America/Sao_Paulo`), as `YYYY-MM-DD`. */
export const todayInSaoPaulo = (now: Date = new Date()): string => saoPauloClock(now).day;

export const addDays = (day: string, count: number): string => fromMs(toMs(day) + count * DAY_MS);

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / DAY_MS);

/** 0 is Sunday: the calendar's week starts on "dom" (decision 2026-11-11). */
const weekdayIndex = (day: string): number => new Date(toMs(day)).getUTCDay();

export const startOfWeek = (day: string): string => addDays(day, -weekdayIndex(day));

const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

const lastOfMonth = (day: string): string => addDays(`${fromMs(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 1)).slice(0, 7)}-01`, -1);

/** The anchor in the URL, or today when it is absent or not a real day. */
export const parseAnchor = (raw: string | null, today: string): string => {
  const parsed = CalendarDaySchema.safeParse(raw);
  return parsed.success ? parsed.data : today;
};

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** The days the grid draws: whole weeks, so a month shows the neighbours' days it spills into. */
export const periodOf = (view: CalendarView, anchor: string): Period => view === 'week'
  ? { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 6) }
  : { from: startOfWeek(firstOfMonth(anchor)), to: addDays(startOfWeek(lastOfMonth(anchor)), 6) };

/** Exactly the days of the month of `anchor`: a list of the month has no neighbours to spill into. */
export const monthPeriod = (anchor: string): Period => ({ from: firstOfMonth(anchor), to: lastOfMonth(anchor) });

export const daysOf = (period: Period): readonly string[] =>
  Array.from({ length: daysBetween(period.from, period.to) + 1 }, (_value, index) => addDays(period.from, index));

/** One period earlier (`-1`) or later (`1`); a month always lands on its first day. */
export const shiftAnchor = (view: CalendarView, anchor: string, direction: -1 | 1): string => {
  if (view === 'week') return addDays(anchor, direction * 7);
  return direction === 1 ? addDays(lastOfMonth(anchor), 1) : firstOfMonth(addDays(firstOfMonth(anchor), -1));
};

const capitalized = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const dayOfMonth = (day: string): number => Number(day.slice(8, 10));
const monthName = (day: string): string => MONTHS[Number(day.slice(5, 7)) - 1]!;

/** "Outubro 2026" for a month; "12 a 18 de outubro de 2026" for a week, spelling both months when it straddles two. */
export const periodTitle = (view: CalendarView, anchor: string): string => {
  if (view === 'month') return `${capitalized(monthName(anchor))} ${anchor.slice(0, 4)}`;
  const { from, to } = periodOf('week', anchor);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayOfMonth(from)} a ${dayOfMonth(to)} de ${monthName(to)} de ${to.slice(0, 4)}`;
  const fromYear = from.slice(0, 4) === to.slice(0, 4) ? '' : ` de ${from.slice(0, 4)}`;
  return `${dayOfMonth(from)} de ${monthName(from)}${fromYear} a ${dayOfMonth(to)} de ${monthName(to)} de ${to.slice(0, 4)}`;
};

/** "segunda-feira, 12 de outubro de 2026": the day in full, for the readers that do not see the grid. */
export const fullDayLabel = (day: string): string =>
  `${WEEKDAYS[weekdayIndex(day)]}, ${dayOfMonth(day)} de ${monthName(day)} de ${day.slice(0, 4)}`;

/** "ter": the weekday as the grid header spells it. */
export const weekdayShortLabel = (day: string): string => WEEKDAY_LABELS[weekdayIndex(day)]!;

/** "12/10": a day and month from the text, never from a `Date`. */
export const dayMonthLabel = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

const MONTH_ABBREVIATIONS = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'] as const;

/** "03 de ago.": the day the hover card says the content goes out, from the text, never from a `Date`. */
export const dayMonthNameLabel = (day: string): string => `${day.slice(8, 10)} de ${MONTH_ABBREVIATIONS[Number(day.slice(5, 7)) - 1]!}`;

/** "11 de novembro": the day and the month in full, from the text, never from a `Date`. */
export const dayOfMonthLabel = (day: string): string => `${dayOfMonth(day)} de ${monthName(day)}`;

/** "27 nov": the short date of a tile of the feed, from the text, never from a `Date`. */
export const shortDayLabel = (day: string): string => `${dayOfMonth(day)} ${MONTH_ABBREVIATIONS[Number(day.slice(5, 7)) - 1]!.replace('.', '')}`;
