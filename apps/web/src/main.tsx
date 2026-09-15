import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { loadBrowserConfig } from './config.js';
import './styles.css';

const config = loadBrowserConfig();

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('The application root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App config={config} />
  </StrictMode>
);
