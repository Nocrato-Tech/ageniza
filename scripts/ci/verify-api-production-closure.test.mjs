import { describe, expect, it } from 'vitest';

import { FORBIDDEN_IN_API_PRODUCTION, forbiddenPackagesIn, packageNameFromStoreEntry } from './verify-api-production-closure.mjs';

describe('pnpm virtual-store entry names', () => {
  it('reads the package name before the version and its peer suffixes', () => {
    expect(packageNameFromStoreEntry('better-auth@1.7.5')).toBe('better-auth');
    expect(packageNameFromStoreEntry('vitest@3.2.7(@types/node@22.20.2)(jsdom@26.1.0)')).toBe('vitest');
  });

  it('reads a scoped package', () => {
    expect(packageNameFromStoreEntry('@types+node@22.20.2')).toBe('@types/node');
    expect(packageNameFromStoreEntry('@fastify+rate-limit@10.3.0')).toBe('@fastify/rate-limit');
  });
});

describe('API production closure', () => {
  it('accepts a closure without the test tooling', () => {
    expect(forbiddenPackagesIn(['better-auth@1.7.5', '@fastify+rate-limit@10.3.0', 'pg@8.16.3'])).toEqual([]);
  });

  it('reports vitest and its chain, once each and sorted', () => {
    expect(forbiddenPackagesIn(['vitest@3.2.7', 'vite@7.1.0', 'tinypool@2.1.2', 'vitest@3.2.7'])).toEqual(['tinypool', 'vite', 'vitest']);
    for (const name of FORBIDDEN_IN_API_PRODUCTION) {
      expect(forbiddenPackagesIn([`${name}@1.0.0`])).toEqual([name]);
    }
  });

  it('reports the vitest scoped packages through their scope', () => {
    expect(forbiddenPackagesIn(['@vitest+expect@3.2.7', '@vitest+runner@3.2.7', '@vitest+utils@3.2.7']))
      .toEqual(['@vitest/expect', '@vitest/runner', '@vitest/utils']);
  });

  it('does not flag a package whose name merely contains a forbidden one', () => {
    expect(forbiddenPackagesIn(['vite-plugin-checker@1.0.0', 'postcssify@2.0.0', 'jsdom-global@3.0.2'])).toEqual([]);
  });
});
