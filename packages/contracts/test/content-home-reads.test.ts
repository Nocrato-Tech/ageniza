import { describe, expect, it } from 'vitest';

import {
  ActivationStepSchema,
  ContentActivationResponseSchema,
  ContentPeriodResponseSchema,
  ContentSummaryResponseSchema,
  StoryScriptListItemSchema
} from '../src/index.js';

const uuid = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-10T15:00:00.000Z';
const without = (value: object, key: string): object => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('the steps of the activation path of the agency (decision 2026-11-11)', () => {
  const step = { at: AT, name: 'Padaria Doce' };
  const facts = { hasContent: true, sentForApproval: true, approvedByClient: false, published: false };
  const steps = { firstClient: step, firstContent: { at: AT, name: 'Post de abertura' }, firstSent: { ...step, others: 2 }, firstApproved: null };

  it('carries the four facts and, per step, its instant and a name, or null when the step was not taken', () => {
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps } }).success).toBe(true);
    const none = { firstClient: null, firstContent: null, firstSent: null, firstApproved: null };
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: none } }).success).toBe(true);
  });

  it('counts the other people only on the send step, as a whole number that is not negative', () => {
    for (const others of [0, 1, 49]) {
      expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: { ...steps, firstSent: { ...step, others } } } }).success, String(others)).toBe(true);
    }
    for (const others of [-1, 1.5, '2', null]) {
      expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: { ...steps, firstSent: { ...step, others } } } }).success, JSON.stringify(others)).toBe(false);
    }
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: { ...steps, firstClient: { ...step, others: 1 } } } }).success).toBe(false);
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: { ...steps, firstSent: without(step, 'others') } } }).success).toBe(false);
  });

  it('refuses a step with a day instead of an instant, with no name, with an e-mail or an id, and a missing or extra step', () => {
    for (const bad of [{ at: '2026-11-10', name: 'x' }, { at: AT }, { name: 'x' }, { at: AT, name: 'x', email: 'a@b.co' }, { at: AT, name: 'x', userId: uuid(1) }, { at: null, name: 'x' }, { at: AT, name: null }]) {
      expect(ActivationStepSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: without(steps, 'firstApproved') } }).success).toBe(false);
    expect(ContentActivationResponseSchema.safeParse({ data: { ...facts, steps: { ...steps, firstPublished: step } } }).success).toBe(false);
    expect(ContentActivationResponseSchema.safeParse({ data: facts }).success).toBe(false);
  });
});

describe('the counters of the Início of the agency (decision 2026-11-11)', () => {
  const data = { awaitingClient: 5, overdueAwaitingClient: 2, approvedThisMonth: 7, approvedLastMonth: 4, scheduled: { count: 3, lastPublishOn: '2026-11-30' } };

  it('carries what waits, what is late, what was approved this month and the month before, and how many are scheduled with the last day', () => {
    expect(ContentSummaryResponseSchema.parse({ data })).toEqual({ data });
    expect(ContentSummaryResponseSchema.safeParse({ data: { ...data, scheduled: { count: 0, lastPublishOn: null } } }).success).toBe(true);
    expect(ContentSummaryResponseSchema.safeParse({ data: { awaitingClient: 0, overdueAwaitingClient: 0, approvedThisMonth: 0, approvedLastMonth: 0, scheduled: { count: 0, lastPublishOn: null } } }).success).toBe(true);
  });

  it('refuses a negative or fractional count, a missing counter and anything beyond the counters', () => {
    for (const bad of [
      { ...data, awaitingClient: -1 }, { ...data, overdueAwaitingClient: 1.5 }, { ...data, approvedThisMonth: '7' }, { ...data, approvedLastMonth: null },
      without(data, 'approvedLastMonth'), without(data, 'scheduled'), { ...data, scheduled: { count: 1 } }, { ...data, scheduled: { lastPublishOn: null } },
      { ...data, scheduled: { count: -1, lastPublishOn: null } }, { ...data, scheduled: { ...data.scheduled, ids: [uuid(1)] } }, { ...data, clients: [uuid(1)] }
    ]) {
      expect(ContentSummaryResponseSchema.safeParse({ data: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ContentSummaryResponseSchema.safeParse({ data, meta: {} }).success).toBe(false);
    expect(ContentSummaryResponseSchema.safeParse(data).success).toBe(false);
  });
});

describe('the story script in the calendar', () => {
  const script = { id: uuid(1), scriptOn: '2026-11-12', status: 'recorded', sceneCount: 4 };

  it('carries its day, its state ("gravado" is recorded) and how many scenes it has', () => {
    expect(StoryScriptListItemSchema.parse(script)).toEqual(script);
    expect(StoryScriptListItemSchema.safeParse({ ...script, sceneCount: 0 }).success).toBe(true);
    expect(StoryScriptListItemSchema.safeParse({ ...script, status: 'draft' }).success).toBe(true);
  });

  it('refuses a missing, negative, fractional or text scene count, and the scenes themselves', () => {
    for (const bad of [without(script, 'sceneCount'), { ...script, sceneCount: -1 }, { ...script, sceneCount: 2.5 }, { ...script, sceneCount: '4' }, { ...script, scenes: [] }]) {
      expect(StoryScriptListItemSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads through the calendar of a period', () => {
    const empty = { data: { contents: [], storyScripts: [script] }, meta: { from: '2026-11-01', to: '2026-11-30', count: 1 } };
    expect(ContentPeriodResponseSchema.safeParse(empty).success).toBe(true);
    expect(ContentPeriodResponseSchema.safeParse({ ...empty, data: { contents: [], storyScripts: [without(script, 'sceneCount')] } }).success).toBe(false);
  });
});
