const GIB = 1024 ** 3;

const reais = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const reaisWithCents = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "R$ 197" for a whole amount and "R$ 0,40" otherwise; the Intl no-break space is normalised for plain text. */
export const formatBrl = (cents: number): string => (cents % 100 === 0 ? reais : reaisWithCents).format(cents / 100).split(String.fromCharCode(160)).join(' ');

export const formatGb = (bytes: number): string => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(bytes / GIB)} GB`;

const day = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });

export const formatInstant = (iso: string): string => day.format(new Date(iso));

/** A `YYYY-MM-DD` day of São Paulo is written as it is, with no time zone conversion that could move it. */
export const formatDay = (value: string): string => {
  const [year, month, dayOfMonth] = value.split('-');
  return `${dayOfMonth}/${month}/${year}`;
};

/** The total line: "R$ 197 + R$ 42 = R$ 239/mês", or just the price when nothing extra is bought. */
export const totalLine = (planCents: number, extrasCents: number, totalCents: number): string =>
  extrasCents > 0 ? `${formatBrl(planCents)} + ${formatBrl(extrasCents)} = ${formatBrl(totalCents)}/mês` : `${formatBrl(totalCents)}/mês`;
