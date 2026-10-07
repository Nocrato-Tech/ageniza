// The combining marks `normalize(..., NFD)` decomposes accented letters into (U+0300..U+036F).
const COMBINING_MARKS_PATTERN = '[\u0300-\u036f]';

/**
 * Case- and accent-insensitive form of a text expression, for every listing that orders or searches
 * "sem diferenciar maiúsculas nem acento" (`specs/clientes.md` §6, `specs/colaboradores.md` §6).
 * `normalize(..., NFD)` decomposes a composed accented letter (NFC), the regexp removes the combining
 * marks, and `lower()` handles the remaining ASCII -- so the fold covers uppercase and NFD input.
 * The database has no `unaccent` extension, and adding one is a migration, which the contribution
 * rules keep in its own change; every column and search term goes through this exact expression so
 * they can never diverge.
 *
 * The fold only normalizes the text: an ORDER BY over it still needs an explicit deterministic
 * collation (`collate "C"`) to be the same in every database, since the database collation decides
 * spaces, hyphens and digits. The argument is always a fixed column chosen by the caller, never a
 * request value.
 */
export const foldTextSql = (expression: string): string =>
  `lower(regexp_replace(normalize(${expression}, NFD), '${COMBINING_MARKS_PATTERN}', '', 'g'))`;
