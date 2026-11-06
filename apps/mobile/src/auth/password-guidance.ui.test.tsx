// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';

vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'ActivityIndicator'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { PasswordField } from './PasswordField';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);

function NewPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  return <><PasswordField newPassword label="Nova senha" value={password} onChangeText={setPassword} /><PasswordField confirmationFor={password} label="Confirme a senha" value={confirmation} onChangeText={setConfirmation} /></>;
}
const enter = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('shows actual missing requirements and a distinct, live strength estimate before submit', () => {
  render(<NewPasswordForm />);
  expect(screen.getByText('Pelo menos 10 caracteres')).toBeTruthy();
  expect(screen.getByText('No máximo 128 caracteres')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: 'Força estimada da senha' }).getAttribute('aria-valuenow')).toBe('0');
  enter('Nova senha', 'abc');
  expect(screen.getByText('Faltam 7 caracteres para o mínimo.')).toBeTruthy();
  enter('Nova senha', 'aaaaaaaaaa');
  expect(screen.getByText('Tamanho aceito.')).toBeTruthy();
  expect(screen.getByText('Fraca')).toBeTruthy();
  enter('Nova senha', 'caderno nuvem oceano distante');
  expect(screen.getByText('Forte')).toBeTruthy();
  expect(screen.getByText('Estimativa local; não verifica senhas vazadas.')).toBeTruthy();
  enter('Nova senha', 'a'.repeat(129));
  expect(screen.getByText('Remova 1 caractere para ficar dentro do limite.')).toBeTruthy();
  expect(screen.getByLabelText('Nova senha').getAttribute('aria-invalid')).toBe('true');
});

it('explains confirmation while typing and rechecks it when the original password changes', () => {
  render(<NewPasswordForm />);
  enter('Nova senha', 'a-long-password');
  expect(screen.getByText('Repita a senha exatamente como no campo acima.')).toBeTruthy();
  enter('Confirme a senha', 'a-long');
  expect(screen.getByText('Continue digitando para repetir a senha inteira.')).toBeTruthy();
  expect(screen.getByLabelText('Confirme a senha').getAttribute('aria-invalid')).toBe('false');
  enter('Confirme a senha', 'different');
  expect(screen.getByText('As senhas precisam ser iguais.')).toBeTruthy();
  expect(screen.getByText('Confira os dois campos ou use o botão de mostrar senha.')).toBeTruthy();
  expect(screen.getByLabelText('Confirme a senha').getAttribute('aria-invalid')).toBe('true');
  enter('Confirme a senha', 'a-long-password');
  expect(screen.getByText('As senhas coincidem.')).toBeTruthy();
  expect(screen.queryByText('As senhas precisam ser iguais.')).toBeNull();
  enter('Nova senha', 'another-password');
  expect(screen.queryByText('As senhas coincidem.')).toBeNull();
  expect(screen.getByText('As senhas precisam ser iguais.')).toBeTruthy();
});

it('associates guidance with its field and leaves existing-password fields free of policy guidance', () => {
  const { rerender } = render(<PasswordField newPassword label="Senha" value="a-long-password" />);
  const description = screen.getByLabelText('Senha').getAttribute('aria-describedby');
  expect(description).toBeTruthy();
  expect(document.getElementById(description!)).toBeTruthy();
  rerender(<PasswordField label="Senha" value="short" autoComplete="current-password" />);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByLabelText('Senha').getAttribute('aria-invalid')).toBe('false');
  expect(screen.getByLabelText('Senha').getAttribute('autocomplete')).toBe('current-password');
});
