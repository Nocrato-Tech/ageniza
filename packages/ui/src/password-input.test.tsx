// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Field, PasswordInput } from './index.js';

afterEach(cleanup);

it('reveals and hides the same password without submitting or losing selection and focus', () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(<form onSubmit={submit}><Field label="Senha">{(control) => <PasswordInput {...control} name="password" autoComplete="current-password" defaultValue="secret value" />}</Field></form>);
  const input = screen.getByLabelText('Senha') as HTMLInputElement;
  input.focus();
  input.setSelectionRange(2, 6);
  expect(input.type).toBe('password');
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
  expect(input.type).toBe('text');
  expect(input.value).toBe('secret value');
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(6);
  expect(document.activeElement).toBe(input);
  expect(input.autocomplete).toBe('current-password');
  expect(screen.getByRole('button', { name: 'Ocultar senha' }).getAttribute('aria-controls')).toBe(input.id);
  fireEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
  expect(input.type).toBe('password');
  expect(submit).not.toHaveBeenCalled();
});

it('reports Caps Lock from real keyboard state, preserves descriptions and clears on blur', () => {
  render(<><p id="policy">Política existente</p><Field label="Senha">{(control) => <PasswordInput {...control} aria-describedby="policy" />}</Field></>);
  const input = screen.getByLabelText('Senha');
  fireEvent.keyUp(input, { key: 'A', modifierCapsLock: true });
  const warning = screen.getByText('Caps Lock ativado.');
  expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual(['policy', warning.id]);
  fireEvent.blur(input);
  expect(screen.queryByText('Caps Lock ativado.')).toBeNull();
  expect(input.getAttribute('aria-describedby')).toBe('policy');
});

it('keeps disabled, required, ref and consumer keyboard handlers while suppressing text corrections', () => {
  const onKeyUp = vi.fn();
  const ref = { current: null as HTMLInputElement | null };
  const { rerender } = render(<Field label="Nova senha">{(control) => <PasswordInput {...control} ref={ref} disabled required autoComplete="new-password" onKeyUp={onKeyUp} />}</Field>);
  const input = screen.getByLabelText('Nova senha') as HTMLInputElement;
  expect(ref.current).toBe(input);
  expect(input.disabled).toBe(true);
  expect(input.required).toBe(true);
  expect((screen.getByRole('button', { name: 'Mostrar senha' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<Field label="Nova senha">{(control) => <PasswordInput {...control} ref={ref} required autoComplete="new-password" onKeyUp={onKeyUp} />}</Field>);
  fireEvent.keyUp(input, { key: 'a' });
  expect(onKeyUp).toHaveBeenCalledOnce();
  expect(input.getAttribute('autocapitalize')).toBe('none');
  expect(input.getAttribute('autocorrect')).toBe('off');
  expect(input.getAttribute('spellcheck')).toBe('false');
});
