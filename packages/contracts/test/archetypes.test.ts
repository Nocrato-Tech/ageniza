import { describe, expect, it } from 'vitest';

import { ARCHETYPE_LABELS, ArchetypeSchema } from '../src/index.js';

// specs/clientes.md section 3, "Seção do estudo de marca": the archetype is one of twelve. The
// pairs below are written out by value on purpose: iterating ARCHETYPE_LABELS would only compare
// the constant with itself (checklist item 5, issue #464).
const SPEC_ARCHETYPES = [
  ['innocent', 'Inocente'],
  ['sage', 'Sábio'],
  ['explorer', 'Explorador'],
  ['outlaw', 'Fora-da-lei'],
  ['magician', 'Mago'],
  ['hero', 'Herói'],
  ['lover', 'Amante'],
  ['jester', 'Bobo da corte'],
  ['everyman', 'Cara comum'],
  ['caregiver', 'Cuidador'],
  ['ruler', 'Governante'],
  ['creator', 'Criador']
] as const;

describe('archetypes (issue #464)', () => {
  it('has exactly the twelve keys of the SPEC, in the SPEC order', () => {
    expect(ArchetypeSchema.options).toEqual(SPEC_ARCHETYPES.map(([key]) => key));
  });

  it.each(SPEC_ARCHETYPES)('labels %s as the SPEC text %s', (key, label) => {
    expect(ARCHETYPE_LABELS[key]).toBe(label);
    expect(ArchetypeSchema.safeParse(key).success).toBe(true);
  });

  it('has no label beyond the twelve and no two keys share one', () => {
    expect(Object.keys(ARCHETYPE_LABELS)).toHaveLength(12);
    expect(new Set(Object.values(ARCHETYPE_LABELS)).size).toBe(12);
  });

  it.each(['Herói', 'hero ', 'Hero', 'wizard', '', null])('refuses %j as an archetype key', (value) => {
    expect(ArchetypeSchema.safeParse(value).success).toBe(false);
  });
});
