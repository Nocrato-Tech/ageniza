// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorSummary, Field, focusFirstInvalid, Select, TextInput, useFormErrors } from './index.js';

afterEach(cleanup);

describe('ErrorSummary', () => {
  it('says nothing for one field or none, and names every field, in order, for two or more', () => {
    const { rerender } = render(<ErrorSummary labels={[]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<ErrorSummary labels={['E-mail']} />);
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<ErrorSummary labels={['Dia dos stories', 'Texto da cena 1', 'Orientação da cena 1']} />);
    expect(screen.getByRole('alert').textContent).toBe('Corrija 3 campos: Dia dos stories, Texto da cena 1, Orientação da cena 1.');
    expect(screen.getByRole('alert').querySelector('.ui-icon svg')).not.toBeNull();
  });
});

describe('focusFirstInvalid', () => {
  it('focuses the first control the form marks invalid, in the order of the form, and says whether there was one', () => {
    render(<form aria-label="f">
      <input aria-label="a" />
      <input aria-label="b" aria-invalid="true" />
      <input aria-label="c" aria-invalid="true" />
    </form>);
    const form = screen.getByRole('form');

    expect(focusFirstInvalid(form)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('b'));
    expect(focusFirstInvalid(null)).toBe(false);
    screen.getByLabelText('b').removeAttribute('aria-invalid');
    screen.getByLabelText('c').removeAttribute('aria-invalid');
    expect(focusFirstInvalid(form)).toBe(false);
  });
});

/** A form that refuses what it is told to refuse: the errors are state, as in the screens. */
function Harness({ late = false }: { late?: boolean }) {
  const { formRef, attempted, summary } = useFormErrors();
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [values, setValues] = useState({ name: '', password: '', role: '' });
  const refuse = (): void => {
    const next = {
      name: values.name === '' ? 'Informe o nome.' : undefined,
      password: values.password === '' ? 'Informe a senha.' : undefined,
      role: values.role === '' ? 'Escolha o papel.' : undefined
    };
    if (late) setTimeout(() => setErrors(next), 0);
    else setErrors(next);
  };
  return <>
    <form ref={formRef} aria-label="cadastro" onSubmit={(event) => { event.preventDefault(); refuse(); }} noValidate>
      {summary}
      <Field label="Nome" error={errors.name}>
        {(control) => <TextInput {...control} value={values.name} onChange={(event) => { setValues({ ...values, name: event.target.value }); setErrors({ ...errors, name: undefined }); }} />}
      </Field>
      <Field label="Senha" error={errors.password}>
        {(control) => <TextInput {...control} value={values.password} onChange={(event) => { setValues({ ...values, password: event.target.value }); setErrors({ ...errors, password: undefined }); }} />}
      </Field>
      <Select label="Papel" value={values.role} options={[{ value: 'a', label: 'A' }]} placeholder="Selecione" error={errors.role} onChange={(role) => setValues({ ...values, role })} />
      <button type="submit">Enviar</button>
    </form>
    <button type="button" onClick={() => { refuse(); attempted(); }}>sem submit</button>
  </>;
}

/** The second field turns invalid while the person types in the first one, long after the submit that armed the form. */
function Confirmation() {
  const { formRef, summary } = useFormErrors();
  const [password, setPassword] = useState('abc');
  const [confirmation] = useState('abc');
  return <form ref={formRef} aria-label="senha" onSubmit={(event) => { event.preventDefault(); }} noValidate>
    {summary}
    <Field label="Senha">{(control) => <TextInput {...control} value={password} onChange={(event) => setPassword(event.target.value)} />}</Field>
    <Field label="Confirmação" error={confirmation === password ? undefined : 'A confirmação não confere.'}>{(control) => <TextInput {...control} value={confirmation} readOnly />}</Field>
    <button type="submit">Enviar</button>
  </form>;
}

function LateForm() {
  const { formRef, summary } = useFormErrors();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Abrir</button>;
  return <form ref={formRef} aria-label="tarde" onSubmit={(event) => { event.preventDefault(); setError('Informe o nome.'); }} noValidate>
    {summary}
    <Field label="Nome" error={error}>{(control) => <TextInput {...control} />}</Field>
    <button type="submit">Enviar</button>
  </form>;
}

describe('useFormErrors', () => {
  it('on a refused submit, focuses the first invalid control and gives exactly one alert that names all of them', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await screen.findByRole('alert');
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('Corrija 3 campos: Nome, Senha, Papel.');
    for (const label of ['Nome', 'Senha', 'Papel']) {
      const control = screen.getByLabelText(label);
      const message = control.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!).find((node) => node.classList.contains('ui-field-message'))!;
      expect(control.getAttribute('aria-invalid'), label).toBe('true');
      expect(message, label).not.toBeNull();
      expect(message.getAttribute('role'), label).toBeNull();
    }
  });

  it('follows what is still invalid, and drops the alert when one field is left, without moving the focus', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByRole('alert');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana' } });
    expect(screen.getByRole('alert').textContent).toBe('Corrija 2 campos: Senha, Papel.');
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Papel').getAttribute('aria-invalid')).toBe('true');
  });

  it('puts the focus back on the first invalid control each time the form is refused again', async () => {
    render(<Harness />);
    const submit = screen.getByRole('button', { name: 'Enviar' });
    fireEvent.click(submit);
    await screen.findByRole('alert');
    submit.focus();

    fireEvent.click(submit);
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
  });

  it('moves the focus when the server answers later, and not before there is anything invalid', async () => {
    render(<Harness late />);
    const submit = screen.getByRole('button', { name: 'Enviar' });
    submit.focus();
    fireEvent.click(submit);
    expect(document.activeElement).toBe(submit);

    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); });
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('does not take the focus away from a person who is typing when another field turns invalid under their hands', () => {
    render(<Confirmation />);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const password = screen.getByLabelText('Senha');
    password.focus();

    fireEvent.input(password, { target: { value: 'abcd' } });
    expect(screen.getByLabelText('Confirmação').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(password);
  });

  it('binds a form that mounts after the first render', async () => {
    render(<LateForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    const submit = screen.getByRole('button', { name: 'Enviar' });
    submit.focus();

    fireEvent.click(submit);
    await screen.findByLabelText('Nome');
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
  });

  it('arms by hand for a button that validates on its own, with no submit event', async () => {
    render(<Harness />);
    const manual = screen.getByRole('button', { name: 'sem submit' });
    manual.focus();

    fireEvent.click(manual);
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
  });

  it('is quiet before any refusal: no alert and no focus move', () => {
    render(<Harness />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
