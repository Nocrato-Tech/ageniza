import { describe, expect, it } from 'vitest';

import { AgencyPlanSchema, CreateAgencyRequestSchema } from '../src/index.js';

// The name of an agency created by the product (issue #709) is the only thing the body carries.
describe('CreateAgencyRequestSchema', () => {
  it('accepts a display name and trims it', () => {
    expect(CreateAgencyRequestSchema.parse({ name: '  Estúdio Novo  ' })).toEqual({ name: 'Estúdio Novo' });
  });

  it.each([
    ['blank', '   '],
    ['a zero-width space', 'Nome​invisível'],
    ['a bidi override', 'Agência‮abc'],
    ['a word joiner', 'Agência⁠Nova'],
    ['more than 256 bytes', 'á'.repeat(129)]
  ])('refuses a name with %s', (_label, name) => {
    expect(CreateAgencyRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it('refuses any field but the name', () => {
    expect(CreateAgencyRequestSchema.safeParse({ name: 'Agência', plan: 'isenta' }).success).toBe(false);
  });
});

describe('AgencyPlanSchema', () => {
  it('carries the support contact only as an e-mail or null', () => {
    const plan = { kind: 'trial', trialEndsAt: '2026-11-10T03:00:00.000Z', readOnly: true };
    expect(AgencyPlanSchema.parse({ ...plan, supportContactEmail: null }).supportContactEmail).toBeNull();
    expect(AgencyPlanSchema.parse({ ...plan, supportContactEmail: 'suporte@ageniza.com.br' }).supportContactEmail).toBe('suporte@ageniza.com.br');
    expect(AgencyPlanSchema.safeParse({ ...plan, supportContactEmail: 'suporte' }).success).toBe(false);
  });
});
