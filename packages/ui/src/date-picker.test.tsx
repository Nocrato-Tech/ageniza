// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatePicker, Field, type DatePickerProps } from './index.js';

afterEach(cleanup);

const TODAY = '2026-10-16';

function Harness({ initial = '', onValue, ...props }: Partial<DatePickerProps> & { initial?: string; onValue?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <Field label="Dia dos stories">
    {(control) => <DatePicker {...control} {...props} today={TODAY} value={value} onChange={(next) => { setValue(next); onValue?.(next); }} />}
  </Field>;
}

const field = (): HTMLInputElement => screen.getByLabelText('Dia dos stories') as HTMLInputElement;
const toggle = (): HTMLButtonElement => screen.getByRole('button', { name: 'Abrir calendário' }) as HTMLButtonElement;
const panel = (): HTMLElement | null => screen.queryByRole('dialog');
const dayButton = (day: string): HTMLButtonElement => {
  const found = panel()!.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
  if (found === null) throw new Error(`No button for ${day}`);
  return found;
};
const type = (value: string): void => { fireEvent.change(field(), { target: { value } }); };
const key = (name: string, init: KeyboardEventInit = {}): boolean => fireEvent.keyDown(document.activeElement!, { key: name, ...init });

describe('DatePicker field', () => {
  it('shows the day as dd/mm/aaaa and names the format for assistive technology', () => {
    render(<Harness initial="2026-10-20" />);

    expect(field().value).toBe('20/10/2026');
    expect(field().placeholder).toBe('dd/mm/aaaa');
    expect(field().getAttribute('inputmode')).toBe('numeric');
    expect(field().getAttribute('autocomplete')).toBe('off');
    const hint = document.getElementById(field().getAttribute('aria-describedby')!.split(' ').at(-1)!)!;
    expect(hint.textContent).toBe('Digite o dia como dia/mês/ano ou abra o calendário.');
  });

  it('gives the day to the form as YYYY-MM-DD once the typed day is whole and real', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);

    type('25102026');

    expect(field().value).toBe('25/10/2026');
    expect(seen).toHaveBeenLastCalledWith('2026-10-25');
  });

  it('gives an empty value while the day is partial, impossible or cleared, and keeps what was typed', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-20" onValue={seen} />);

    type('25/10/20');
    expect(seen).toHaveBeenLastCalledWith('');
    expect(field().value).toBe('25/10/20');

    type('31022026');
    expect(seen).toHaveBeenLastCalledWith('');
    expect(field().value).toBe('31/02/2026');

    type('');
    expect(seen).toHaveBeenLastCalledWith('');
    expect(field().value).toBe('');
  });

  it('accepts a day pasted as YYYY-MM-DD and shows it the way it is typed', () => {
    const seen = vi.fn();
    render(<Harness onValue={seen} />);

    type('2026-10-25');

    expect(seen).toHaveBeenLastCalledWith('2026-10-25');
    expect(field().value).toBe('25/10/2026');
  });

  it('keeps a half-typed day when the form echoes an empty value back, and rewrites it when the value changes from outside', () => {
    function Resettable() {
      const [value, setValue] = useState('');
      return <>
        <Field label="Dia">{(control) => <DatePicker {...control} today={TODAY} value={value} onChange={setValue} />}</Field>
        <button type="button" onClick={() => setValue('2026-11-03')}>Redefinir</button>
      </>;
    }
    render(<Resettable />);
    const input = screen.getByLabelText('Dia') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0311' } });
    expect(input.value).toBe('03/11');

    fireEvent.click(screen.getByRole('button', { name: 'Redefinir' }));
    expect(input.value).toBe('03/11/2026');
  });

  it('hands the field control props to the input and marks it invalid with the error', () => {
    render(<Field label="Dia dos stories" error="Informe o dia dos stories.">{(control) => <DatePicker {...control} today={TODAY} value="" onChange={() => undefined} />}</Field>);

    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toContain(`${field().id}-error`);
    expect(screen.getByText('Informe o dia dos stories.')).toBeTruthy();
  });

  it('is frozen with the form while it is disabled', () => {
    render(<Harness initial="2026-10-20" disabled />);

    expect(field().disabled).toBe(true);
    expect(toggle().disabled).toBe(true);
  });
});

describe('DatePicker calendar', () => {
  it('opens on the chosen day, in its month, with the toggle expanded', () => {
    render(<Harness initial="2026-10-20" />);

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe(panel()!.id);
    expect(within(panel()!).getByRole('heading', { name: 'outubro de 2026' })).toBeTruthy();
    expect(document.activeElement).toBe(dayButton('2026-10-20'));
    expect(dayButton('2026-10-20').getAttribute('tabindex')).toBe('0');
    expect(dayButton('2026-10-21').getAttribute('tabindex')).toBe('-1');
    expect(dayButton('2026-10-20').closest('td')!.getAttribute('aria-selected')).toBe('true');
    expect(dayButton('2026-10-21').closest('td')!.getAttribute('aria-selected')).toBe('false');
  });

  it('opens on today when nothing is chosen, and marks today for assistive technology', () => {
    render(<Harness />);

    fireEvent.click(toggle());

    expect(document.activeElement).toBe(dayButton(TODAY));
    expect(dayButton(TODAY).getAttribute('aria-current')).toBe('date');
    expect(dayButton('2026-10-15').getAttribute('aria-current')).toBeNull();
  });

  it('opens on the typed day, not on the last one picked', () => {
    render(<Harness initial="2026-10-20" />);

    type('03/12/2026');
    fireEvent.click(toggle());

    expect(within(panel()!).getByRole('heading', { name: 'dezembro de 2026' })).toBeTruthy();
    expect(document.activeElement).toBe(dayButton('2026-12-03'));
  });

  it('lays six Monday-first weeks, each day named in full, with the neighbours of the month dimmed but pickable', () => {
    render(<Harness initial="2026-10-20" />);

    fireEvent.click(toggle());

    expect(within(panel()!).getAllByRole('gridcell')).toHaveLength(42);
    expect(within(panel()!).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']);
    expect(dayButton('2026-10-12').getAttribute('aria-label')).toBe('segunda-feira, 12 de outubro de 2026');
    expect(dayButton('2026-10-12').textContent).toBe('12');
    expect(dayButton('2026-09-28').className).toContain('ui-date-picker__day--outside');
    expect(dayButton('2026-10-12').className).not.toContain('ui-date-picker__day--outside');
    expect(dayButton('2026-09-28').disabled).toBe(false);
  });

  it('picks a day: gives it to the form, writes it in the field, closes and hands the focus back to the toggle', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-20" onValue={seen} />);

    fireEvent.click(toggle());
    fireEvent.click(dayButton('2026-10-27'));

    expect(seen).toHaveBeenLastCalledWith('2026-10-27');
    expect(field().value).toBe('27/10/2026');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('picks a day of the neighbouring month and lands on it', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-20" onValue={seen} />);

    fireEvent.click(toggle());
    fireEvent.click(dayButton('2026-11-02'));

    expect(seen).toHaveBeenLastCalledWith('2026-11-02');
  });

  it('goes to the other month with the buttons without taking the focus from them, keeping the day number', () => {
    render(<Harness initial="2026-10-20" />);
    fireEvent.click(toggle());

    const next = within(panel()!).getByRole('button', { name: 'Próximo mês' });
    next.focus();
    fireEvent.click(next);

    expect(within(panel()!).getByRole('heading', { name: 'novembro de 2026' })).toBeTruthy();
    expect(document.activeElement).toBe(next);
    expect(dayButton('2026-11-20').getAttribute('tabindex')).toBe('0');

    fireEvent.click(within(panel()!).getByRole('button', { name: 'Mês anterior' }));
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Mês anterior' }));
    expect(within(panel()!).getByRole('heading', { name: 'setembro de 2026' })).toBeTruthy();
  });

  it('has a Hoje button that picks today, and a Fechar that closes without picking', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-20" onValue={seen} />);

    fireEvent.click(toggle());
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Fechar' }));
    expect(panel()).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle());

    fireEvent.click(toggle());
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Hoje' }));
    expect(seen).toHaveBeenLastCalledWith(TODAY);
  });

  it('closes with the toggle pressed again', () => {
    render(<Harness />);

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(panel()).toBeNull();
  });

  it('opens with Alt+ArrowDown from the field, and not with ArrowDown alone', () => {
    render(<Harness initial="2026-10-20" />);

    field().focus();
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(panel()).toBeNull();
    fireEvent.keyDown(field(), { key: 'ArrowDown', altKey: true });

    expect(document.activeElement).toBe(dayButton('2026-10-20'));
  });
});

describe('DatePicker keyboard', () => {
  const opened = (initial = '2026-10-14'): void => {
    render(<Harness initial={initial} />);
    fireEvent.click(toggle());
  };

  it.each([
    ['ArrowRight', {}, '2026-10-15'],
    ['ArrowLeft', {}, '2026-10-13'],
    ['ArrowDown', {}, '2026-10-21'],
    ['ArrowUp', {}, '2026-10-07'],
    ['Home', {}, '2026-10-12'],
    ['End', {}, '2026-10-18'],
    ['PageDown', {}, '2026-11-14'],
    ['PageUp', {}, '2026-09-14'],
    ['PageDown', { shiftKey: true }, '2027-10-14'],
    ['PageUp', { shiftKey: true }, '2025-10-14']
  ] as const)('moves the focus on %s %j to %s', (name, init, target) => {
    opened();

    key(name, init);

    expect(document.activeElement).toBe(dayButton(target));
    expect(document.activeElement!.getAttribute('tabindex')).toBe('0');
  });

  it('crosses into the next month with the arrow and shows it', () => {
    opened('2026-10-31');

    key('ArrowRight');

    expect(document.activeElement).toBe(dayButton('2026-11-01'));
    expect(within(panel()!).getByRole('heading', { name: 'novembro de 2026' })).toBeTruthy();
  });

  it('pulls a month jump back into a shorter month', () => {
    opened('2026-01-31');

    key('PageDown');

    expect(document.activeElement).toBe(dayButton('2026-02-28'));
  });

  it('picks the focused day with Enter and Space (the native button click)', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-14" onValue={seen} />);
    fireEvent.click(toggle());
    key('ArrowRight');

    fireEvent.click(document.activeElement!);

    expect(seen).toHaveBeenLastCalledWith('2026-10-15');
  });

  it('ignores a movement key pressed on a button that is not a day', () => {
    opened();
    const next = within(panel()!).getByRole('button', { name: 'Próximo mês' });
    next.focus();

    const notCancelled = fireEvent.keyDown(next, { key: 'ArrowRight' });

    expect(notCancelled).toBe(true);
    expect(document.activeElement).toBe(next);
  });

  it('closes only the calendar on Esc: the key is cancelled so the dialog around it stays, and the focus goes to the toggle', () => {
    opened();
    const escape = createEvent.keyDown(document.activeElement!, { key: 'Escape', bubbles: true, cancelable: true });
    const outer = vi.fn();
    document.addEventListener('keydown', outer);

    fireEvent(document.activeElement!, escape);
    document.removeEventListener('keydown', outer);

    expect(escape.defaultPrevented).toBe(true);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});

describe('DatePicker limits', () => {
  it('disables the days outside min and max, and a click on one picks nothing', () => {
    const seen = vi.fn();
    render(<Harness initial="2026-10-14" min="2026-10-10" max="2026-10-20" onValue={seen} />);

    fireEvent.click(toggle());

    expect(dayButton('2026-10-09').disabled).toBe(true);
    expect(dayButton('2026-10-10').disabled).toBe(false);
    expect(dayButton('2026-10-20').disabled).toBe(false);
    expect(dayButton('2026-10-21').disabled).toBe(true);
    fireEvent.click(dayButton('2026-10-21'));
    expect(seen).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it('keeps the keyboard inside the limits', () => {
    render(<Harness initial="2026-10-20" min="2026-10-10" max="2026-10-20" />);
    fireEvent.click(toggle());

    key('ArrowRight');
    expect(document.activeElement).toBe(dayButton('2026-10-20'));

    key('PageUp');
    expect(document.activeElement).toBe(dayButton('2026-10-10'));
  });

  it('opens on the nearest allowed day when the value is outside the limits', () => {
    render(<Harness initial="2026-12-31" max="2026-10-20" />);

    fireEvent.click(toggle());

    expect(document.activeElement).toBe(dayButton('2026-10-20'));
  });

  it('does not offer Hoje when today is outside the limits, and offers it inside them', () => {
    const { unmount } = render(<Harness initial="2026-10-14" max="2026-10-15" />);
    fireEvent.click(toggle());
    expect(within(panel()!).queryByRole('button', { name: 'Hoje' })).toBeNull();
    unmount();

    render(<Harness initial="2026-10-14" max={TODAY} />);
    fireEvent.click(toggle());
    expect(within(panel()!).getByRole('button', { name: 'Hoje' })).toBeTruthy();
  });

  it('leaves a typed day outside the limits to the form, as the native field did', () => {
    const seen = vi.fn();
    render(<Harness max="2026-10-20" onValue={seen} />);

    type('25/10/2026');

    expect(seen).toHaveBeenLastCalledWith('2026-10-25');
  });
});

describe('DatePicker closing', () => {
  it('closes with a press outside, and not with a press inside', () => {
    render(<><p>Fora</p><Harness initial="2026-10-20" /></>);
    fireEvent.click(toggle());

    fireEvent.pointerDown(panel()!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('Fora'));
    expect(panel()).toBeNull();
  });

  it('closes when the focus lands outside, and stays open when it goes nowhere or inside', () => {
    render(<><button type="button">Outro</button><Harness initial="2026-10-20" /></>);
    fireEvent.click(toggle());

    fireEvent.blur(dayButton('2026-10-20'), { relatedTarget: null });
    expect(panel()).not.toBeNull();
    fireEvent.blur(dayButton('2026-10-20'), { relatedTarget: panel()!.querySelector('button') });
    expect(panel()).not.toBeNull();
    fireEvent.blur(dayButton('2026-10-20'), { relatedTarget: screen.getByRole('button', { name: 'Outro' }) });
    expect(panel()).toBeNull();
  });

  it('closes when the page scrolls or resizes, but not when the calendar itself scrolls', () => {
    render(<Harness initial="2026-10-20" />);
    fireEvent.click(toggle());

    fireEvent.scroll(panel()!);
    expect(panel()).not.toBeNull();
    fireEvent.scroll(window);
    expect(panel()).toBeNull();

    fireEvent.click(toggle());
    fireEvent(window, new Event('resize'));
    expect(panel()).toBeNull();
  });

  it('closes when it becomes disabled with the calendar open', () => {
    const { rerender } = render(<DatePicker today={TODAY} value="" onChange={() => undefined} />);
    fireEvent.click(toggle());
    expect(panel()).not.toBeNull();

    rerender(<DatePicker today={TODAY} value="" onChange={() => undefined} disabled />);

    expect(panel()).toBeNull();
  });
});
