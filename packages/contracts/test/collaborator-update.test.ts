import { describe, expect, it } from 'vitest';

import {
  COLLABORATOR_JOB_TITLE_MAX_LENGTH,
  CollaboratorJobTitleSchema,
  CollaboratorListQuerySchema,
  UpdateCollaboratorRequestSchema
} from '../src/index.js';

const roleId = '66666666-6666-4666-8666-666666666666';

describe('CollaboratorJobTitleSchema (issue #97)', () => {
  it('trims, and bounds the length in UTF-16 units before the database ever sees it', () => {
    expect(CollaboratorJobTitleSchema.parse('  Editor de Vídeo \t')).toBe('Editor de Vídeo');
    expect(CollaboratorJobTitleSchema.safeParse('a'.repeat(COLLABORATOR_JOB_TITLE_MAX_LENGTH)).success).toBe(true);
    expect(CollaboratorJobTitleSchema.safeParse('a'.repeat(COLLABORATOR_JOB_TITLE_MAX_LENGTH + 1)).success).toBe(false);
    // Astral characters are two UTF-16 units each, the same count the database CHECK enforces. The
    // title needs a letter (issue #324), so the boundary is built with two letters and 127 emoji
    // (256 units) against 128 emoji (258 units).
    expect(CollaboratorJobTitleSchema.safeParse('aa' + '😀'.repeat(127)).success).toBe(true);
    expect(CollaboratorJobTitleSchema.safeParse('aa' + '😀'.repeat(128)).success).toBe(false);
    expect(CollaboratorJobTitleSchema.safeParse('😀'.repeat(129)).success).toBe(false);
    expect(CollaboratorJobTitleSchema.safeParse('a'.repeat(900_000)).success).toBe(false);
  });

  it('refuses empty, whitespace-only and control characters, inside the text as well', () => {
    for (const value of ['', '   ', '\t', ' ', '﻿', 'Edi\ntor', 'Edi\u0000tor', 'Edi\ttor', 'Edi\u007Ftor', '\u001B[31mx']) {
      expect(CollaboratorJobTitleSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('accepts only titles the job title filter of the listing can select', () => {
    const samples = [
      'Editor', ' Editor ', 'Gestor (Operação) 100%', 'Designer  Sênior', 'a'.repeat(256), 'a'.repeat(257), '😀'.repeat(129),
      '', '   ', 'Edi\ntor', 'Edi\tor', 'Edi\u0000tor', 'Edi\u007Ftor', 'x\u0085y', 'x y', 'x​y'
    ];
    for (const sample of samples) {
      const stored = CollaboratorJobTitleSchema.safeParse(sample).success;
      const filtered = CollaboratorListQuerySchema.safeParse({ jobTitle: sample }).success;
      // A stored title the filter refuses could never be filtered by, so the write must not allow it.
      // The other direction no longer holds on purpose: the write follows the display-name rule
      // (issue #324) and the filter only refuses C0 and DEL, so it accepts a superset.
      if (stored) expect(filtered, JSON.stringify(sample)).toBe(true);
    }
  });
});

describe('UpdateCollaboratorRequestSchema (issue #97)', () => {
  it('accepts either field or both, and null to clear the title', () => {
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: 'Editor' }).success).toBe(true);
    expect(UpdateCollaboratorRequestSchema.safeParse({ roleId }).success).toBe(true);
    expect(UpdateCollaboratorRequestSchema.safeParse({ jobTitle: 'Editor', roleId }).success).toBe(true);
    expect(UpdateCollaboratorRequestSchema.parse({ jobTitle: null })).toEqual({ jobTitle: null });
  });

  it('rejects an empty body, an unknown field, a null role and a role that is not a uuid', () => {
    for (const body of [{}, { extra: 1 }, { jobTitle: 'Editor', extra: 1 }, { roleId: null }, { roleId: 'not-a-uuid' }, null, 'x', []]) {
      expect(UpdateCollaboratorRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
