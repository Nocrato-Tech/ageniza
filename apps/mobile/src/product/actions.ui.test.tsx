// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'ActivityIndicator'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => { const { createElement } = await import('react'); const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children); return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) }; });
import { ContentActions } from './ContentActions';
import type { Data, Post } from './types';
afterEach(cleanup);
it('blocks an invalid reschedule date before calling the mutation', async () => {
  const onMove = vi.fn();
  render(<ContentActions post={{ status: 'cancelled', date: '2026-11-06', title: 'Revisar capa' } as Post} data={{ permissions: ['*'], readOnly: false } as Data} busy={false} onMove={onMove} />);
  fireEvent.change(screen.getByLabelText(/Nova data proposta/), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reagendar e voltar à produção' }));
  expect(onMove).not.toHaveBeenCalled();
  expect(await screen.findByText('Escolha uma data válida para continuar.')).toBeTruthy();
});
it('names the cancelled content and disables every action while saving', () => {
  const onMove = vi.fn();
  const props = { post: { status: 'in_production', date: '2026-11-06', title: 'Check-up de novembro' } as Post, data: { permissions: ['*'], readOnly: false } as Data, onMove };
  const view = render(<ContentActions {...props} busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar conteúdo' }));
  expect(screen.getByText('Cancelar “Check-up de novembro”?')).toBeTruthy();
  view.rerender(<ContentActions {...props} busy />);
  for (const button of screen.getAllByRole('button')) expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
  expect(onMove).not.toHaveBeenCalled();
});
it('rejects a future publication date and keeps a valid calendar-day payload intact', async () => {
  const onMove = vi.fn();
  render(<ContentActions post={{ status: 'approved', date: '2099-11-06', title: 'Check-up' } as Post} data={{ permissions: ['*'], readOnly: false } as Data} busy={false} onMove={onMove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Informar data real da publicação' }));
  fireEvent.click(screen.getByRole('button', { name: 'Registrar publicação' }));
  expect(await screen.findByText('A data real da publicação não pode ser futura.')).toBeTruthy();
  expect(onMove).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Data real da publicação'), { target: { value: '2026-01-15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar publicação' }));
  expect(onMove).toHaveBeenCalledExactlyOnceWith('publish', undefined, '2026-01-15');
});
