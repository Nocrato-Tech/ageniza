/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envDir: '../..',
  plugins: [react()],
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
    env: { TZ: 'UTC' }
  }
});