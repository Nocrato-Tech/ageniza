import { describe, expect, it } from 'vitest';

import { folderFunctionRefusal, isFolderParentViolation, removeAsset } from './folder-service.js';

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

// Issue #531, item 3. `remove_media_asset` answers a boolean whose `false` means "already removed", so the route
// writes no audit event for it: a null (or anything that is not a boolean) must stop the route, not read as `false`.
describe('what removing a media takes from the function', () => {
  const answering = (rows: readonly unknown[]): Parameters<typeof removeAsset>[0] =>
    ({ raw: async () => ({ rows }) }) as unknown as Parameters<typeof removeAsset>[0];

  it('passes on the boolean the function gave, the true and the false', async () => {
    expect(await removeAsset(answering([{ removed: true }]), 'asset', 'folder')).toBe(true);
    expect(await removeAsset(answering([{ removed: false }]), 'asset', 'folder')).toBe(false);
  });

  it.each([[null], [undefined], ['t'], ['true'], [1], [0]])('fails loudly when it answers %s, instead of reading it as "not removed"', async (removed) => {
    await expect(removeAsset(answering([{ removed }]), 'asset', 'folder')).rejects.toThrow('did not return a boolean');
  });

  it('fails loudly when it answers no row at all', async () => {
    await expect(removeAsset(answering([]), 'asset', 'folder')).rejects.toThrow('returned no row');
  });
});
