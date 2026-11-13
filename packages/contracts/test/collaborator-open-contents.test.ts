import { describe, expect, it } from 'vitest';

import {
  COLLABORATOR_OPEN_CONTENTS_MAX_CLIENTS,
  COLLABORATOR_OPEN_CONTENTS_NOW_LIMIT,
  CollaboratorOpenContentsQuerySchema,
  CollaboratorOpenContentsResponseSchema
} from '../src/index.js';

const id = '77777777-7777-4777-8777-777777777777';
const content = (state: string) => ({ contentId: id, title: 'Reels', state });
const entry = (now: unknown[]) => ({ client: { id, name: 'Casa Aurora' }, contents: now.length, awaiting: 0, now });

describe('the open contents of a collaborator', () => {
  it('declares no query parameter', () => {
    expect(CollaboratorOpenContentsQuerySchema.safeParse({}).success).toBe(true);
    expect(CollaboratorOpenContentsQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
  });

  it('accepts only the four open states, and nothing past three per client or a hundred clients', () => {
    const summary = { clients: 1, contents: 1, awaiting: 0 };
    for (const state of ['in_production', 'awaiting_approval', 'adjusting', 'approved']) {
      expect(CollaboratorOpenContentsResponseSchema.safeParse({ summary, data: [entry([content(state)])] }).success, state).toBe(true);
    }
    for (const state of ['published', 'cancelled', 'draft']) {
      expect(CollaboratorOpenContentsResponseSchema.safeParse({ summary, data: [entry([content(state)])] }).success, state).toBe(false);
    }
    const tooMany = Array.from({ length: COLLABORATOR_OPEN_CONTENTS_NOW_LIMIT + 1 }, () => content('approved'));
    expect(CollaboratorOpenContentsResponseSchema.safeParse({ summary, data: [entry(tooMany)] }).success).toBe(false);
    const clients = Array.from({ length: COLLABORATOR_OPEN_CONTENTS_MAX_CLIENTS + 1 }, () => entry([content('approved')]));
    expect(CollaboratorOpenContentsResponseSchema.safeParse({ summary, data: clients }).success).toBe(false);
  });

  it('answers a zeroed summary and no clients', () => {
    expect(CollaboratorOpenContentsResponseSchema.safeParse({ summary: { clients: 0, contents: 0, awaiting: 0 }, data: [] }).success).toBe(true);
  });
});
