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
