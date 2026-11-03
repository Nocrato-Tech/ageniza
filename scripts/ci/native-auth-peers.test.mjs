import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { hooks } = require('../../.pnpmfile.cjs');
describe('native optional peers stay out of the server auth closure', () => {
  it('removes each native peer while retaining the auth dependencies', () => {
    const names = ['expo-constants', 'expo-linking', 'expo-network', 'expo-secure-store', 'expo-web-browser'];
    const pkg = hooks.readPackage({ name: '@better-auth/expo', peerDependencies: { ...Object.fromEntries(names.map((name) => [name, '*'])), 'better-auth': '^1.7.5' }, peerDependenciesMeta: Object.fromEntries(names.map((name) => [name, { optional: true }])) });
    expect(pkg.peerDependencies).toEqual({ 'better-auth': '^1.7.5' });
    expect(pkg.peerDependenciesMeta).toEqual({});
  });
  it('retains the existing test-tooling exclusion and leaves other packages alone', () => {
    expect(hooks.readPackage({ name: 'better-auth', peerDependencies: { vitest: '*', react: '*' }, peerDependenciesMeta: { vitest: { optional: true } } })).toEqual({ name: 'better-auth', peerDependencies: { react: '*' }, peerDependenciesMeta: {} });
    const other = { name: 'other', peerDependencies: { 'expo-network': '*' } };
    expect(hooks.readPackage(other)).toBe(other);
    expect(other.peerDependencies).toEqual({ 'expo-network': '*' });
  });
});
