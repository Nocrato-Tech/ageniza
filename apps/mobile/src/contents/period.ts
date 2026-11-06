export function monthPeriod(offset = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value) - 1 + offset;
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), label: first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}
export const formatNames = { image: 'Imagem', carousel: 'Carrossel', reels: 'Reels', long_video: 'Vídeo', vsl: 'VSL' };
export const statusNames = { in_production: 'Em produção', awaiting_approval: 'Aguardando aprovação', adjusting: 'Em ajuste', approved: 'Pronto para publicar', published: 'Publicado', cancelled: 'Cancelado' };
export const displayDay = (day: string) => day.split('-').reverse().slice(0, 2).join('/');

// Day-of-month bands for the monthly production chart. `lastDay` comes from the real month (`period.to`), so 28, 29, 30 and 31 are all honest.
export function dayBands(lastDay: number) {
  const bands = [[1, 7], [8, 14], [15, 21], [22, 28]].map(([from, to]) => ({ from, to, label: `${from}–${to}` }));
  if (lastDay >= 29) bands.push({ from: 29, to: lastDay, label: lastDay === 29 ? '29' : `29–${lastDay}` });
  return bands;
}
// The day comes from the YYYY-MM-DD text (São Paulo day), never from a local Date.
export const dayOfMonth = (date: string) => Number(date.slice(8, 10));
