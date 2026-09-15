import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadWebConfig } from '@ageniza/config/browser';

const config = loadWebConfig(import.meta.env);

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('The application root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <main data-api-base-url={config.apiBaseUrl}>Ageniza</main>
  </StrictMode>
);
