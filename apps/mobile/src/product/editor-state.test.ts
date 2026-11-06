import { expect, it } from 'vitest';
import { editorErrors } from './editor-state';
import type { PostInput } from './types';
const input: PostInput = { clientId: '', folderId: '', title: '', caption: '', format: 'image', date: '2026-11-06', time: '', ownerId: '', mediaIds: [], coverId: null };
it('reports actionable format-stage field errors without blocking on later date fields', () => {
  expect(editorErrors({ ...input, date: 'bad' }, 0)).toEqual({ clientId: 'Escolha o cliente deste conteúdo.', title: 'Informe um título de até 120 caracteres.', folderId: 'Escolha uma pasta para as mídias.' });
});
