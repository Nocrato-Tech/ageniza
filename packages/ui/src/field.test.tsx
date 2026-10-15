// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Field, Select, Textarea, TextInput } from './index.js';

afterEach(cleanup);

const describedBy = (control: HTMLElement): string[] => (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
const text = (id: string): string | null | undefined => document.getElementById(id)?.textContent;

describe('Field', () => {
  it('binds the visible label to the control it wraps', () => {
    render(<Field label="Título">{(control) => <TextInput {...control} />}</Field>);

    const input = screen.getByLabelText('Título');
    expect(input.tagName).toBe('INPUT');
    expect(screen.getByText('Título').tagName).toBe('LABEL');
  });

  it('names the control by the label for an input, a textarea and a select alike', () => {
    render(
      <>
        <Field label="Título">{(control) => <TextInput {...control} />}</Field>
        <Field label="Legenda">{(control) => <Textarea {...control} />}</Field>
        <Select label="Papel" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => undefined} />
      </>
    );

    expect(screen.getByRole('textbox', { name: 'Título' }).tagName).toBe('INPUT');
    expect(screen.getByRole('textbox', { name: 'Legenda' }).tagName).toBe('TEXTAREA');
    expect(screen.getByRole('combobox', { name: 'Papel' }).tagName).toBe('SELECT');
  });

  it('keeps two fields apart: each label reaches its own control', () => {
    render(
      <>
        <Field label="Nome">{(control) => <TextInput {...control} />}</Field>
        <Field label="Cargo">{(control) => <TextInput {...control} />}</Field>
      </>
    );

    expect(screen.getByLabelText('Nome').id).not.toBe(screen.getByLabelText('Cargo').id);
  });

  it('uses the id it is given', () => {
    render(<Field label="Título" id="titulo">{(control) => <TextInput {...control} />}</Field>);

    expect(screen.getByLabelText('Título').id).toBe('titulo');
  });

  it('adds nothing to the control when there is no hint, counter, error or loading', () => {
    render(<Field label="Título">{(control) => <TextInput {...control} />}</Field>);
    const input = screen.getByLabelText('Título');

    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-busy')).toBe(false);
  });

  it('describes the control by the hint, the counter and the error, in that order', () => {
    render(
      <Field label="Legenda" hint="Aparece no feed" counter={{ count: 12, max: 2200 }} error="Escreva a legenda antes de enviar">
        {(control) => <Textarea {...control} />}
      </Field>
    );
    const ids = describedBy(screen.getByLabelText('Legenda'));

    expect(ids.map(text)).toEqual(['Aparece no feed', '12/2200', 'Escreva a legenda antes de enviar']);
  });

  it('describes the control only by what is present', () => {
    render(<Field label="Título" hint="Até 80 caracteres">{(control) => <TextInput {...control} />}</Field>);

    expect(describedBy(screen.getByLabelText('Título')).map(text)).toEqual(['Até 80 caracteres']);
  });

  it('marks the control invalid and shows the error with an icon, so it is never colour alone', () => {
    render(<Field label="E-mail" error="Esse e-mail não parece certo">{(control) => <TextInput {...control} />}</Field>);
    const input = screen.getByLabelText('E-mail');
    const message = screen.getByText('Esse e-mail não parece certo');

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(message.className).toBe('ui-field-message');
    expect(message.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('announces the error when it appears, and says nothing while the field is fine', () => {
    const { rerender } = render(<Field label="E-mail">{(control) => <TextInput {...control} />}</Field>);
    expect(screen.queryByRole('alert')).toBeNull();

    rerender(<Field label="E-mail" error="Esse e-mail não parece certo">{(control) => <TextInput {...control} />}</Field>);
    expect(screen.getByRole('alert').textContent).toBe('Esse e-mail não parece certo');
    expect(screen.getByLabelText('E-mail').getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('counts the characters used against the limit', () => {
    render(<Field label="Legenda" counter={{ count: 2200, max: 2200 }}>{(control) => <Textarea {...control} />}</Field>);
    const counter = screen.getByText('2200/2200');

    expect(counter.className.split(' ')).not.toContain('ui-field__counter--over');
    expect(counter.querySelector('.ui-icon')).toBeNull();
    expect(screen.getByLabelText('Legenda').hasAttribute('aria-invalid')).toBe(false);
  });

  it('marks the control invalid and flags the counter with an icon once it goes over the limit', () => {
    render(<Field label="Legenda" counter={{ count: 2201, max: 2200 }}>{(control) => <Textarea {...control} />}</Field>);
    const counter = screen.getByText('2201/2200');

    expect(screen.getByLabelText('Legenda').getAttribute('aria-invalid')).toBe('true');
    expect(counter.className.split(' ')).toContain('ui-field__counter--over');
    expect(counter.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says it is busy while loading and leaves the control editable', () => {
    render(<Field label="E-mail" loading>{(control) => <TextInput {...control} />}</Field>);
    const input = screen.getByLabelText('E-mail') as HTMLInputElement;

    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.closest('.ui-field')?.classList.contains('ui-field--loading')).toBe(true);
  });

  it('keeps what the consumer sets on the control: disabled and required pass through', () => {
    render(<Field label="Título">{(control) => <TextInput {...control} disabled required />}</Field>);
    const input = screen.getByLabelText('Título') as HTMLInputElement;

    expect(input.disabled).toBe(true);
    expect(input.required).toBe(true);
  });
});

describe('Select on a Field', () => {
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

  it('takes a hint and an error like any field, and marks itself invalid', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} hint="Quem pode aprovar" error="Escolha um papel" />);
    const select = screen.getByRole('combobox', { name: 'Papel' });

    expect(describedBy(select).map(text)).toEqual(['Quem pode aprovar', 'Escolha um papel']);
    expect(select.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the description the consumer already gave it', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} hint="Quem pode aprovar" aria-describedby="fora" />);

    expect(describedBy(screen.getByRole('combobox', { name: 'Papel' })).filter((id) => id === 'fora')).toEqual(['fora']);
    expect(describedBy(screen.getByRole('combobox', { name: 'Papel' }))).toHaveLength(2);
  });

  it('keeps the id it is given and its disabled state', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} id="papel" disabled />);
    const select = screen.getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;

    expect(select.id).toBe('papel');
    expect(select.disabled).toBe(true);
  });

  it('says it is busy while loading', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} loading />);

    expect(screen.getByRole('combobox', { name: 'Papel' }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('Select keeps what the consumer sets', () => {
  const options = [{ value: 'a', label: 'A' }];

  it('keeps the aria-invalid it was given when the field has no error of its own', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} aria-invalid={true} />);

    expect(screen.getByRole('combobox', { name: 'Papel' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('is not invalid when neither the consumer nor the field says so', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} aria-invalid={false} />);

    expect(screen.getByRole('combobox', { name: 'Papel' }).getAttribute('aria-invalid')).toBe('false');
  });

  it('is invalid when the field has an error, whatever the consumer said', () => {
    render(<Select label="Papel" value="a" options={options} onChange={() => undefined} aria-invalid={false} error="Escolha um papel" />);

    expect(screen.getByRole('combobox', { name: 'Papel' }).getAttribute('aria-invalid')).toBe('true');
  });
});
