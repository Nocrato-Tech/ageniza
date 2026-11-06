export const cn = (...values: (string | undefined)[]) => values.filter(Boolean).join(' ');
