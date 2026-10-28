/**
 * Day arithmetic on `YYYY-MM-DD` text. A day is never read through the browser's time zone, so the picked day is the
 * one on screen on any machine: `Date.UTC` only counts days, it never tells which day it is.
 */
const DAY_MS = 86_400_000;

const toMs = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'] as const;
const WEEKDAY_NAMES = ['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'] as const;

/** A real calendar day: `2026-02-31` has the right shape and is not one. */
export const isCalendarDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && fromMs(toMs(value)) === value;

export const addDays = (day: string, count: number): string => fromMs(toMs(day) + count * DAY_MS);

/** 0 is Monday: the grid's week starts on "seg", like the calendar of the screens. */
export const weekdayIndex = (day: string): number => (new Date(toMs(day)).getUTCDay() + 6) % 7;

export const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

/** The same day number `count` months away, pulled back to the last day when that month is shorter (31 Jan + 1 = 28 Feb). */
export const addMonths = (day: string, count: number): string => {
  const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + count;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(Number(day.slice(8, 10)), last)).padStart(2, '0')}`;
};

/** The 42 days of a six-week grid that holds the month of `day`, Monday first, with the neighbours' days at the ends. */
export const monthGrid = (day: string): readonly string[] => {
  const first = firstOfMonth(day);
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 42 }, (_value, index) => addDays(start, index));
};

/** "outubro de 2026". */
export const monthTitle = (day: string): string => `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]!} de ${day.slice(0, 4)}`;

/** "segunda-feira, 12 de outubro de 2026". */
export const fullDay = (day: string): string =>
  `${WEEKDAY_NAMES[weekdayIndex(day)]!}, ${Number(day.slice(8, 10))} de ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]!} de ${day.slice(0, 4)}`;

/** `2026-10-12` as typed by a person: `12/10/2026`. An empty or unreal value shows as written. */
export const toTyped = (day: string): string => (isCalendarDay(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day);

/**
 * What a person types, as a day: `12/10/2026`, or `2026-10-12` when it is pasted from elsewhere. Anything that is not
 * a whole, real day is `''`: the caller treats it like an empty field and says what is missing.
 */
export const fromTyped = (text: string): string => {
  const typed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  const day = typed === null ? text.trim() : `${typed[3]}-${typed[2]}-${typed[1]}`;
  return isCalendarDay(day) ? day : '';
};

/** Keeps only digits, then lays the slashes as the digits arrive: `12102026` reads `12/10/2026`. A pasted `2026-10-12` stays whole. */
export const maskTyped = (text: string): string => {
  if (/^\d{4}-/.test(text)) return text.slice(0, 10);
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};
