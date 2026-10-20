import { readFileSync } from 'node:fs';

import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Files already over the budget when the rule arrived; the list only shrinks (pnpm quality:file-size --prune).
const maxLinesBaseline = JSON.parse(
  readFileSync(new URL('./scripts/quality/max-lines-baseline.json', import.meta.url), 'utf8')
);

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: ['**/*.test.{ts,tsx}', '**/test/**', ...maxLinesBaseline.files],
    rules: {
      'max-lines': ['error', { max: maxLinesBaseline.max }]
    }
  }
);
