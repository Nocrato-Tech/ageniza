import { describe, expect, it } from 'vitest';

import {
  AGENCY_SEARCH_GROUP_LIMIT,
  AgencySearchQuerySchema,
  AgencySearchResponseSchema,
  AGENCY_SEARCH_TERM_MIN_LENGTH,
  searchedCharacters
} from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const client = { id, name: 'Padaria Central', photoUrl: null, instagramHandle: 'padariacentral', archived: false };
const content = { id, clientId: id, clientName: 'Padaria Central', title: 'Promoção de pães', format: 'reels', status: 'approved', overdue: false, scheduled: true, publishOn: '2026-11-20' };
const file = { id, clientId: id, clientName: 'Padaria Central', folderId: id, name: 'padaria-fachada.jpg', category: 'image', thumbnailAssetId: id };
const response = (data: Record<string, unknown>) => ({ data: { clients: [], contents: [], files: [], ...data }, meta: { q: 'padar' } });

describe('the characters searched of a term', () => {
  const searched = (term: string): number => searchedCharacters(term).length;

  it('drops the accents, composed or not, and keeps the letters', () => {
    expect(searchedCharacters('Promoção')).toBe('Promocao');
    expect(searchedCharacters('promoc\u0327a\u0303o')).toBe('promocao');
    expect(searchedCharacters('á')).toBe('a');
    expect(searchedCharacters('a\u0301')).toBe('a');
    expect(searchedCharacters('\u0301\u0301')).toBe('');
  });

  it('drops the @ of the start, which marks the handle field, and only one', () => {
    expect(searchedCharacters('@padaria')).toBe('padaria');
    expect(searchedCharacters('@@a')).toBe('@a');
    expect(searchedCharacters('@\u0301a')).toBe('a');
    expect(searchedCharacters('a@b')).toBe('a@b');
  });

  it('keeps a lone @, as the search does', () => {
    expect(searchedCharacters('@')).toBe('@');
    expect(searchedCharacters('@\u0301')).toBe('@');
  });

  it('puts @a, a letter with an accent and marks alone below the minimum, and two characters at it', () => {
    expect(searched('@a')).toBeLessThan(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('á')).toBeLessThan(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('a\u0301')).toBeLessThan(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('\u0301\u0301\u0301')).toBeLessThan(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('@@')).toBeLessThan(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('@ab')).toBeGreaterThanOrEqual(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('ab')).toBe(AGENCY_SEARCH_TERM_MIN_LENGTH);
    expect(searched('áb')).toBe(AGENCY_SEARCH_TERM_MIN_LENGTH);
  });
});

describe('the term of the search of the agency', () => {
  it('is trimmed, from 2 to 80 characters', () => {
    expect(AgencySearchQuerySchema.parse({ q: '  ab  ' })).toEqual({ q: 'ab' });
    expect(AgencySearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: ' a ' }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: 'a'.repeat(80) }).success).toBe(true);
    expect(AgencySearchQuerySchema.safeParse({ q: 'a'.repeat(81) }).success).toBe(false);
  });

  it('refuses a control character anywhere in it, a missing term, a term that is not a string and any other parameter', () => {
    for (const q of ['ab\u0000', 'a\u0001b', 'a\nb', 'a\tb', 'ab\u007f', 'a\u001bb']) {
      expect(AgencySearchQuerySchema.safeParse({ q }).success, JSON.stringify(q)).toBe(false);
    }
    expect(AgencySearchQuerySchema.safeParse({}).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: ['ab', 'cd'] }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: 'ab', page: '2' }).success).toBe(false);
    expect(AgencySearchQuerySchema.safeParse({ q: 'ab', limit: '100' }).success).toBe(false);
  });

  it('does not put the term in the issues it reports', () => {
    const result = AgencySearchQuerySchema.safeParse({ q: `zzsegredo${'x'.repeat(80)}` });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).not.toContain('zzsegredo');
    const control = AgencySearchQuerySchema.safeParse({ q: 'zzsegredo\u0001' });
    expect(JSON.stringify(control.success ? {} : control.error.issues)).not.toContain('zzsegredo');
  });
});

describe('the answer of the search of the agency', () => {
  it('always has the three groups, each at most six, and nothing else', () => {
    expect(AGENCY_SEARCH_GROUP_LIMIT).toBe(6);
    expect(AgencySearchResponseSchema.safeParse(response({})).success).toBe(true);
    expect(AgencySearchResponseSchema.safeParse(response({ clients: [client], contents: [content], files: [file] })).success).toBe(true);
    for (const group of ['clients', 'contents', 'files'] as const) {
      const item = { clients: client, contents: content, files: file }[group];
      expect(AgencySearchResponseSchema.safeParse(response({ [group]: Array.from({ length: 6 }, () => item) })).success, group).toBe(true);
      expect(AgencySearchResponseSchema.safeParse(response({ [group]: Array.from({ length: 7 }, () => item) })).success, group).toBe(false);
    }
    for (const group of ['clients', 'contents', 'files'] as const) {
      const data: Record<string, unknown> = { ...response({}).data };
      delete data[group];
      expect(AgencySearchResponseSchema.safeParse({ ...response({}), data }).success, group).toBe(false);
    }
    expect(AgencySearchResponseSchema.safeParse({ ...response({}), extra: 1 }).success).toBe(false);
    expect(AgencySearchResponseSchema.safeParse({ data: response({}).data }).success).toBe(false);
  });

  it('declares the fields of the table of the SPEC for each item, and refuses one more', () => {
    expect(Object.keys(client).sort()).toEqual(['archived', 'id', 'instagramHandle', 'name', 'photoUrl']);
    expect(AgencySearchResponseSchema.safeParse(response({ clients: [{ ...client, taxId: '1' }] })).success).toBe(false);
    expect(AgencySearchResponseSchema.safeParse(response({ contents: [{ ...content, caption: 'x' }] })).success).toBe(false);
    expect(AgencySearchResponseSchema.safeParse(response({ files: [{ ...file, objectKey: 'k' }] })).success).toBe(false);
    for (const status of ['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published', 'cancelled']) {
      expect(AgencySearchResponseSchema.safeParse(response({ contents: [{ ...content, status }] })).success, status).toBe(true);
    }
    for (const category of ['image', 'video', 'pdf', 'audio', 'logo']) {
      expect(AgencySearchResponseSchema.safeParse(response({ files: [{ ...file, category }] })).success, category).toBe(true);
    }
    expect(AgencySearchResponseSchema.safeParse(response({ files: [{ ...file, category: 'zip' }] })).success).toBe(false);
    expect(AgencySearchResponseSchema.safeParse(response({ files: [{ ...file, thumbnailAssetId: null }] })).success).toBe(true);
  });
});
