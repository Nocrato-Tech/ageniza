/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /** `true` in the development build: it turns on the internal /mobile page. The production build never sets it. */
  readonly VITE_DEV_DOCS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
