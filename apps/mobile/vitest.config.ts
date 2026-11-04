import { defineConfig } from 'vitest/config';

export default defineConfig({ esbuild: { jsx: 'automatic' }, test: { server: { deps: { inline: ['@better-auth/expo'] } } } });
