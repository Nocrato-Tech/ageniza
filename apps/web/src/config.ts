import { loadWebConfig, type BrowserConfig } from '@ageniza/config/browser';

/** The only configuration entrypoint available to browser application code. */
export const loadBrowserConfig = (): BrowserConfig => loadWebConfig(import.meta.env);
