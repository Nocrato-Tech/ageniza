import { defineConfig } from 'vitest/config';

export default defineConfig({ esbuild: { jsx: 'automatic' }, test: { maxWorkers: 2, server: { deps: { inline: ['@better-auth/expo'] } } } });
