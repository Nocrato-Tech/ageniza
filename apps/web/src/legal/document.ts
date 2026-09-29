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

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly items?: readonly string[];
}

export const PENDING_MARKER = '[PENDENTE:';

export const DRAFT_NOTICE =
  'MINUTA. Este texto ainda não passou por revisão jurídica e não vale como documento final. Os trechos marcados com [PENDENTE: …] dependem de informação ou decisão que ainda não existe.';
