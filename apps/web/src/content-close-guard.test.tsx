// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { openContent, setupModalTests, stored, type } from './content-modal-fixture.js';
setupModalTests();
it('protects an edited content on close and preserves work when the person continues editing', async () => {
  await openContent(stored({ title: 'Título salvo' }));
  type('Título', 'Alteração não salva');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Descartar alterações?' });
  expect(confirmation.textContent).toContain('As alterações não salvas serão perdidas.');
  fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
  expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Alteração não salva');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Descartar alterações' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('keeps discard confirmation visible when closing from assignment after editing general', async () => {
  await openContent(stored({ title: 'Título salvo' }));
  type('Título', 'Alteração não salva');
  fireEvent.click(screen.getByRole('tab', { name: 'Atribuição' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fechar conteúdo' }));
  expect(await screen.findByRole('dialog', { name: 'Descartar alterações?' })).toBeTruthy();
});
