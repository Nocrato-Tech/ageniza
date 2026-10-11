import { CalendarDaySchema } from '@ageniza/contracts';

/**
 * Calendar arithmetic on `YYYY-MM-DD` strings. A day is never read through the browser's time zone:
 * the agency's day is São Paulo's, and a `Date` built from local fields would flip it near midnight.
 * `Date.UTC` appears only to count days, never to tell which day it is.
 */
export type CalendarView = 'month' | 'week';

const DAY_MS = 86_400_000;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'] as const;
const WEEKDAYS = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'] as const;

export const WEEKDAY_LABELS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'] as const;

const toMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const todayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today in the agency's time zone (`America/Sao_Paulo`), as `YYYY-MM-DD`. */
export const todayInSaoPaulo = (now: Date = new Date()): string => {
  const parts = Object.fromEntries(todayFormatter.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const addDays = (day: string, count: number): string => fromMs(toMs(day) + count * DAY_MS);

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / DAY_MS);

/** 0 is Monday: the calendar's week starts on "seg". */
const weekdayIndex = (day: string): number => (new Date(toMs(day)).getUTCDay() + 6) % 7;

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

/** "12/10": a day and month from the text, never from a `Date`. */
export const dayMonthLabel = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
