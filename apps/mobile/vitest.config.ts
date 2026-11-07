import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    // Same budget as apps/web: a UI test takes ~5 s on a CI runner that shares its CPU with the other packages.
    testTimeout: 20_000,
    server: { deps: { inline: ['@better-auth/expo'] } }
  }
});
