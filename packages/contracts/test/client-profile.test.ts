import { describe, expect, it } from 'vitest';

import {
  ClientDetailResponseSchema,
  ClientMemberAddRequestSchema,
  ClientSummarySchema,
  CreateClientRequestSchema,
  CreatePersonaRequestSchema,
  PERSONA_TRAITS_MAX,
  PERSONA_TRAIT_MAX_LENGTH,
  PersonaSchema,
  PersonaTraitsSchema,
  UpdateClientRequestSchema,
  UpdatePersonaRequestSchema
} from '../src/index.js';

// Decisions 2026-11-11: the city of the client, "quem trabalha neste cliente" and the tab counts, the profile of the persona, and the name
// the agency types for a person of the portal. Code points are spelled as numbers so the invisible characters stay visible in this file.
const text = (...codePoints: readonly number[]): string => String.fromCodePoint(...codePoints);
const id = '77777777-7777-4777-8777-777777777777';
const without = (value: object, key: string): object => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const HIDDEN_OR_MULTILINE = ['Duas\nlinhas', 'Com\ttab', text(0x41, 0x07), text(0x41, 0x00), text(0x41, 0x7f), text(0x41, 0x85), text(0x41, 0x200b), text(0x41, 0x202e)];

describe('the city of the client', () => {
  it('is one trimmed line of up to 80 characters, on create and on edit, and empty clears it', () => {
    expect(CreateClientRequestSchema.parse({ name: 'Padaria', city: '  São José do Rio Preto  ' }).city).toBe('São José do Rio Preto');
    expect(CreateClientRequestSchema.parse({ name: 'Padaria' })).toEqual({ name: 'Padaria' });
    expect(CreateClientRequestSchema.parse({ name: 'Padaria', city: '   ' }).city).toBeNull();
    expect(UpdateClientRequestSchema.parse({ city: 'Campinas' })).toEqual({ city: 'Campinas' });
    expect(UpdateClientRequestSchema.parse({ city: null })).toEqual({ city: null });
    expect(UpdateClientRequestSchema.parse({ city: '' })).toEqual({ city: null });
    expect(UpdateClientRequestSchema.parse({ city: 'a'.repeat(80) }).city).toHaveLength(80);
    expect(UpdateClientRequestSchema.parse({ city: 'ç'.repeat(80) }).city).toHaveLength(80);
  });

  it('refuses a city that is long, in several lines, hidden or not text, and an edit that carries nothing', () => {
    for (const city of ['a'.repeat(81), 'ç'.repeat(81), ...HIDDEN_OR_MULTILINE, 5, ['Campinas'], '!!!']) {
      expect(UpdateClientRequestSchema.safeParse({ city }).success, JSON.stringify(city)).toBe(false);
      expect(CreateClientRequestSchema.safeParse({ name: 'Padaria', city }).success, JSON.stringify(city)).toBe(false);
    }
    expect(UpdateClientRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('the summary of the client (decision 2026-11-11)', () => {
  const base = { brandStudyFilled: 3, threadsAwaitingAgency: 1, threadsAnsweredByAgency: 0, activePortalMembers: 2 };
  const extras = {
    contentsThisMonth: 12, mediaFiles: 40, mediaFolders: 4, workersMore: 2,
    workers: [{ membershipId: id, name: 'Marina Bastos', photoUrl: null }]
  };

  it('has the four counts without the extras, and the extras only together with a reader who may have them', () => {
    expect(ClientSummarySchema.safeParse(base).success).toBe(true);
    expect(ClientSummarySchema.safeParse({ ...base, ...extras }).success).toBe(true);
    expect(Object.keys(ClientSummarySchema.parse(base)).sort()).toEqual(Object.keys(base).sort());
  });

  it('names a worker by the link, the name and the photo, and never by an e-mail or an account', () => {
    for (const worker of [
      { membershipId: id, name: 'Ana', photoUrl: null, email: 'ana@exemplo.test' },
      { membershipId: id, name: 'Ana', photoUrl: null, userId: id },
      { membershipId: 'not-a-uuid', name: 'Ana', photoUrl: null },
      { name: 'Ana', photoUrl: null }
    ]) {
      expect(ClientSummarySchema.safeParse({ ...base, workers: [worker] }).success, JSON.stringify(worker)).toBe(false);
    }
    for (const bad of [{ contentsThisMonth: -1 }, { mediaFiles: 1.5 }, { mediaFolders: -2 }, { workersMore: -1 }, { workers: 'Ana' }, { unknown: 1 }]) {
      expect(ClientSummarySchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rides in the detail of the client next to the city and the date of the registration', () => {
    const detail = {
      id, name: 'Padaria', status: 'active', photoUrl: null, legalName: null, taxId: null, segment: null, city: 'Campinas', website: null,
      instagramHandle: 'padaria', contactName: null, contactPhone: null, contactEmail: null, closingDate: null,
      createdAt: '2026-03-10T12:00:00.000Z', archivedAt: null, summary: { ...base, ...extras }
    };
    expect(ClientDetailResponseSchema.safeParse(detail).success).toBe(true);
    for (const broken of [without(detail, 'city'), without(detail, 'createdAt'), { ...detail, createdAt: 'março' }]) {
      expect(ClientDetailResponseSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('the profile of the persona (decision 2026-11-11)', () => {
  const profile = {
    age: 34, occupation: 'Dona de padaria', location: 'Campinas, SP', traits: ['Prática', 'Desconfiada'],
    whereTheyAre: 'Instagram e grupos de bairro.', toneThatWorks: 'Próximo e direto.'
  };

  it('is optional on create and on edit, and a persona without it is as valid as before', () => {
    expect(CreatePersonaRequestSchema.parse({ name: 'Marina' })).toEqual({ name: 'Marina' });
    expect(CreatePersonaRequestSchema.parse({ name: 'Marina', ...profile })).toEqual({ name: 'Marina', ...profile });
    expect(UpdatePersonaRequestSchema.parse({ age: 35 })).toEqual({ age: 35 });
    expect(UpdatePersonaRequestSchema.safeParse({}).success).toBe(false);
  });

  it('takes an age from 1 to 120 as a whole number, and null to clear it', () => {
    for (const age of [1, 120, 34, null]) expect(UpdatePersonaRequestSchema.parse({ age }).age, String(age)).toBe(age);
    for (const age of [0, 121, -1, 1.5, '30', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(UpdatePersonaRequestSchema.safeParse({ age }).success, String(age)).toBe(false);
    }
  });

  it('takes the occupation and the place as one trimmed line of up to 80 characters, and empty clears them', () => {
    for (const field of ['occupation', 'location'] as const) {
      expect(UpdatePersonaRequestSchema.parse({ [field]: '  Padeira  ' })[field]).toBe('Padeira');
      expect(UpdatePersonaRequestSchema.parse({ [field]: '   ' })[field]).toBeNull();
      expect(UpdatePersonaRequestSchema.parse({ [field]: null })[field]).toBeNull();
      expect(UpdatePersonaRequestSchema.parse({ [field]: 'a'.repeat(80) })[field]).toHaveLength(80);
      for (const value of ['a'.repeat(81), ...HIDDEN_OR_MULTILINE, 5]) {
        expect(UpdatePersonaRequestSchema.safeParse({ [field]: value }).success, `${field} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it('takes "onde está" and "tom que funciona" with up to 280 characters that may break lines, and refuses hidden ones', () => {
    for (const field of ['whereTheyAre', 'toneThatWorks'] as const) {
      expect(UpdatePersonaRequestSchema.parse({ [field]: '  Linha um\nLinha dois  ' })[field]).toBe('Linha um\nLinha dois');
      expect(UpdatePersonaRequestSchema.parse({ [field]: 'a'.repeat(280) })[field]).toHaveLength(280);
      expect(UpdatePersonaRequestSchema.parse({ [field]: '' })[field]).toBeNull();
      expect(UpdatePersonaRequestSchema.parse({ [field]: null })[field]).toBeNull();
      for (const value of ['a'.repeat(281), 'ç'.repeat(281), text(0x41, 0x07), text(0x41, 0x00), text(0x41, 0x200b), text(0x41, 0x202e), 5]) {
        expect(UpdatePersonaRequestSchema.safeParse({ [field]: value }).success, `${field} ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  it('takes up to five traits of up to 24 characters each, one visible line, and an empty list clears them', () => {
    expect(PERSONA_TRAITS_MAX).toBe(5);
    expect(PERSONA_TRAIT_MAX_LENGTH).toBe(24);
    expect(PersonaTraitsSchema.parse([])).toEqual([]);
    expect(PersonaTraitsSchema.parse(['  Prática  ', 'b', 'c', 'd', 'e'])).toEqual(['Prática', 'b', 'c', 'd', 'e']);
    expect(PersonaTraitsSchema.parse(['a'.repeat(24)])).toEqual(['a'.repeat(24)]);
    for (const traits of [
      ['a', 'b', 'c', 'd', 'e', 'f'], ['a'.repeat(25)], [''], ['   '], [5], [null], [['a']], 'Prática', ...HIDDEN_OR_MULTILINE.map((trait) => [trait]),
      [text(0xd800)], [`a${text(0xdc00)}`]
    ]) {
      expect(PersonaTraitsSchema.safeParse(traits).success, JSON.stringify(traits)).toBe(false);
      expect(UpdatePersonaRequestSchema.safeParse({ traits }).success, JSON.stringify(traits)).toBe(false);
    }
  });

  it('is read as a list of traits that is never missing, and the other five as a value or null', () => {
    const persona = {
      id, name: 'Marina', description: null, pains: null, desires: null, objections: null,
      ...profile, status: 'active', updatedBy: null, updatedAt: null
    };
    expect(PersonaSchema.safeParse(persona).success).toBe(true);
    expect(PersonaSchema.safeParse({ ...persona, age: null, occupation: null, location: null, traits: [], whereTheyAre: null, toneThatWorks: null }).success).toBe(true);
    for (const key of ['age', 'occupation', 'location', 'traits', 'whereTheyAre', 'toneThatWorks']) {
      expect(PersonaSchema.safeParse(without(persona, key)).success, key).toBe(false);
    }
    expect(PersonaSchema.safeParse({ ...persona, traits: null }).success).toBe(false);
  });
});

describe('the name the agency types when it adds a person of the portal (decision 2026-11-11)', () => {
  const email = 'debora@exemplo.test';

  it('is optional, trimmed, and empty is no name, so a form that always sends the field works', () => {
    expect(ClientMemberAddRequestSchema.parse({ email })).toEqual({ email });
    expect(ClientMemberAddRequestSchema.parse({ email, name: '  Débora Lima  ' })).toEqual({ email, name: 'Débora Lima' });
    expect(ClientMemberAddRequestSchema.parse({ email, name: '' }).name).toBeUndefined();
    expect(ClientMemberAddRequestSchema.parse({ email, name: '   ' }).name).toBeUndefined();
    expect(ClientMemberAddRequestSchema.parse({ email, name: 'a'.repeat(120) }).name).toHaveLength(120);
  });

  it('has the limit of the name of the profile and refuses what the profile name refuses', () => {
    for (const name of ['a'.repeat(121), 'Duas\nlinhas', text(0x41, 0x07), text(0x41, 0x200b), text(0x41, 0x202e), '!!!', 5, null, ['Ana']]) {
      expect(ClientMemberAddRequestSchema.safeParse({ email, name }).success, JSON.stringify(name)).toBe(false);
    }
    expect(ClientMemberAddRequestSchema.safeParse({ email, nome: 'Ana' }).success).toBe(false);
    expect(ClientMemberAddRequestSchema.safeParse({ name: 'Ana' }).success).toBe(false);
  });
});
