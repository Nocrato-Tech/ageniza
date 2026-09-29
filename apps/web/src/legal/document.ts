/**
 * A legal document served by the web bundle (`/termos`, `/privacidade`), without an API route.
 * `version` is what the API records on acceptance, so it must equal AUTH_TERMS_VERSION or
 * AUTH_PRIVACY_VERSION of the environment that serves this bundle.
 */
export interface LegalDocument {
  readonly title: string;
  /** `YYYY-MM-DD`, the same format the API configuration enforces. */
  readonly version: string;
  /**
   * Present while the text awaits legal review; the page shows it above the content. A reviewed
   * document drops it, and no longer contains any `[PENDENTE: …]` marker.
   */
  readonly draftNotice?: string;
  readonly sections: readonly LegalSection[];
}

/**
 * One block of a section, in the order the document reads. A list belongs to the paragraph that
 * introduces it, which is not always the last one (e.g. "Ele tem dois lados separados:" is followed
 * by two more paragraphs before the list), so the position of each list has to be explicit.
 */
export type LegalBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly items: readonly string[] };

export interface LegalSection {
  readonly heading: string;
  readonly blocks: readonly LegalBlock[];
}

export const paragraph = (text: string): LegalBlock => ({ type: 'paragraph', text });
export const list = (items: readonly string[]): LegalBlock => ({ type: 'list', items });

export const PENDING_MARKER = '[PENDENTE:';

export const DRAFT_NOTICE =
  'MINUTA. Este texto ainda não passou por revisão jurídica e não vale como documento final. Os trechos marcados com [PENDENTE: …] dependem de informação ou decisão que ainda não existe.';
