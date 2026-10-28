/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => ({
  envDir: '../..',
  plugins: [react()],
  // The dev server reads the design system from its source, so an edit in packages/ui shows up without a rebuild.
  // The build and the tests keep the compiled package, which is what ships.
  resolve:
    command === 'serve' && mode === 'development'
      ? { alias: { '@ageniza/ui': fileURLToPath(new URL('../../packages/ui/src/index.tsx', import.meta.url)) } }
      : {},
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query']
        }
      }
    }
  },
  test: {
    // The suite runs with a fixed timezone so a date label that depends on
    // America/Sao_Paulo (the client archiving day, review of #379) cannot silently
    // pass on a machine whose local zone happens to be the production one.
    env: { TZ: 'UTC' },
    // `vitest.setup.ts` lifts the wait of `findBy*`/`waitFor` to 8 s; the test must outlast it, or a screen that
    // never shows up ends as "Test timed out" and not as the Testing Library error with the DOM it dumps.
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20_000,
    // The design-system page reads the token stylesheets as text (`?raw`); vitest would otherwise stub every CSS file as empty.
    css: { include: [/\.css\?raw$/] }
  }
}));
