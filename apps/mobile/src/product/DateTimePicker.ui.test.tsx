// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'ActivityIndicator'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => { const { createElement } = await import('react'); const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children); return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) }; });
import { EditorDateTime } from './EditorDateTime';

afterEach(cleanup);
beforeEach(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }); });

it('keeps text entry, error relationships and exact date strings without any browser-native picker', () => {
  const onChange = vi.fn();
  render(<EditorDateTime kind="date" label="Prazo" value="2026-11-06" error="Data inválida" onChange={onChange} />);
  const input = screen.getByRole('textbox', { name: 'Prazo' });
  expect(input.getAttribute('type')).toBe('text');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain('Data inválida');
  fireEvent.change(input, { target: { value: '2026-02-31' } });
  expect(onChange).toHaveBeenCalledWith('2026-02-31');
  fireEvent.change(input, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith('');
  expect(document.querySelector('input[type="date"],input[type="time"]')).toBeNull();
});

it('stages calendar choices, cancels them, validates typed dates, and only applies an exact valid date', () => {
  const onChange = vi.fn();
  render(<EditorDateTime kind="date" value="2026-11-06" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
  expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Data (AAAA-MM-DD)' }));
  fireEvent.click(screen.getByRole('button', { name: /10 de novembro de 2026/ }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
  expect((screen.getByRole('textbox', { name: 'Data (AAAA-MM-DD)' }) as HTMLInputElement).value).toBe('2026-11-06');
  fireEvent.change(screen.getByRole('textbox', { name: 'Data (AAAA-MM-DD)' }), { target: { value: '2026-02-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  expect(screen.getByText('Informe uma data válida no formato AAAA-MM-DD.')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Data (AAAA-MM-DD)' }), { target: { value: '2028-02-29' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('2028-02-29');
});

it('supports keyboard date selection across a month boundary and commits clearing only on confirmation', () => {
  function Form() { const [value, setValue] = useState('2026-11-30'); return <EditorDateTime kind="date" value={value} onChange={setValue} />; }
  render(<Form />);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Data proposta *' }), { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('button', { name: /30 de novembro de 2026/ }), { key: 'ArrowRight' });
  expect((screen.getByRole('textbox', { name: 'Data (AAAA-MM-DD)' }) as HTMLInputElement).value).toBe('2026-12-01');
  expect(screen.getByRole('button', { name: /, 1 de dezembro de 2026$/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  expect((screen.getByRole('textbox', { name: 'Data proposta *' }) as HTMLInputElement).value).toBe('2026-12-01');
  fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
  fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  expect((screen.getByRole('textbox', { name: 'Data proposta *' }) as HTMLInputElement).value).toBe('');
});

it('selects every hour and minute with branded controls and rejects invalid times', () => {
  const onChange = vi.fn();
  render(<EditorDateTime kind="time" value="18:07" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Escolher horário' }));
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Horas' })).getByRole('option', { name: 'Horas: 23' }));
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Minutos' })).getByRole('option', { name: 'Minutos: 59' }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Hora (HH:MM)' }), { target: { value: '24:60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar horário' }));
  expect(screen.getByText('Informe um horário válido no formato HH:MM.')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Hora (HH:MM)' }), { target: { value: '23:59' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar horário' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('23:59');
});

it('leaves read-only dates visible without opening an editor', () => {
  render(<EditorDateTime kind="date" value="2026-11-06" editable={false} onChange={() => {}} />);
  expect((screen.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Abrir calendário' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
  expect(screen.queryByRole('button', { name: 'Confirmar data' })).toBeNull();
});
