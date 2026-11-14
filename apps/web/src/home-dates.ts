const ZONE = 'America/Sao_Paulo';
const HOUR_MS = 3_600_000;

const longDayFormatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const instantDayFormatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: ZONE });
const monthFormatter = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
const clockFormatter = new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE });
const headingFormatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: ZONE });
const hourFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: ZONE });

/** "9 de novembro" from a `YYYY-MM-DD`, read as text: never through the browser's zone. */
export const longDayLabel = (day: string): string => longDayFormatter.format(new Date(`${day}T12:00:00Z`));

/** "3 de novembro" for the São Paulo day of an instant, or "agora" within the hour before `now`. */
export const instantLabel = (at: string, now: number = Date.now()): string => {
  const instant = Date.parse(at);
  if (now >= instant && now - instant < HOUR_MS) return 'agora';
  return instantDayFormatter.format(new Date(instant));
};

/** "12h" or "22h30": the clock of an instant in São Paulo. */
export const clockLabel = (at: string): string => {
  const parts = Object.fromEntries(clockFormatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return parts.minute === '00' ? `${parts.hour}h` : `${parts.hour}h${parts.minute}`;
};

/** The month before the one of `today` (a `YYYY-MM-DD`), by name: "outubro". */
export const previousMonthName = (today: string): string =>
  monthFormatter.format(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)));

/** "Quarta, 11 de novembro": the weekday without "-feira", in São Paulo. */
export const headingDateLabel = (now: Date): string => {
  const parts = Object.fromEntries(headingFormatter.formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = (parts.weekday ?? '').replace(/-feira$/, '');
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${parts.day} de ${parts.month}`;
};

export const greeting = (now: Date): string => {
  const hour = Number(hourFormatter.format(now));
  if (hour < 12) return 'Bom dia';
  return hour < 18 ? 'Boa tarde' : 'Boa noite';
};
