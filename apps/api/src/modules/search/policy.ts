/**
 * The search is a read that sweeps three tables, so each person has a fixed window of their own, shared by every agency they belong to
 * (specs/busca.md rule 6, a proposal the owner has not changed). The panel waits 250 ms after the last key, so a person typing never
 * gets near it.
 */
export const SEARCH_RATE_LIMIT = { max: 60, windowMs: 60 * 1_000 } as const;
export const SEARCH_RATE_BUCKET = 'agency-search';

/** What each group asks of the person; the Owner holds both by ownership (specs/busca.md section 2). */
export const SEARCH_PERMISSIONS = {
  clients: 'cliente.visualizar',
  contents: 'conteudo.visualizar',
  files: 'conteudo.visualizar'
} as const;
