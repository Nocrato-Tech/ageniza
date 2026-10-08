import { describe, expect, it } from 'vitest';

import { folderFunctionRefusal, isFolderParentViolation } from './folder-service.js';

const failure = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error('boom'), { code, ...extra });

describe('what the media functions and the client gate raise', () => {
  it('maps each database code to its own refusal, and the lost race with the archive to the same one as the archived client', () => {
    expect(folderFunctionRefusal(failure('A0080'))).toBe('not-found');
    expect(folderFunctionRefusal(failure('A0081'))).toBe('client-archived');
    expect(folderFunctionRefusal(failure('A0020'))).toBe('client-archived');
    expect(folderFunctionRefusal(failure('A0082'))).toBe('in-use');
  });

  it('leaves every other error alone, so it stays a 500 instead of passing for a refusal', () => {
    for (const code of ['42501', '23503', 'A0060', 'A0021', '40P01']) expect(folderFunctionRefusal(failure(code))).toBeUndefined();
    expect(folderFunctionRefusal(new Error('no code'))).toBeUndefined();
    expect(folderFunctionRefusal(null)).toBeUndefined();
  });

  it('recognizes only the parent key of the folders as a parent violation', () => {
    expect(isFolderParentViolation(failure('23503', { constraint: 'media_folders_parent_fk' }))).toBe(true);
    expect(isFolderParentViolation(failure('23503', { constraint: 'media_assets_folder_client_fk' }))).toBe(false);
    expect(isFolderParentViolation(failure('23505', { constraint: 'media_folders_parent_fk' }))).toBe(false);
  });
});
