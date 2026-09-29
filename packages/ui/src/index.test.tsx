// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from './index.js';

afterEach(cleanup);

describe('Button', () => {
  it('maps variant and size to classes, and defaults to a non-submitting primary md button', () => {
    render(<><Button>Salvar</Button><Button variant="destructive" size="lg">Remover</Button></>);
    const primary = screen.getByRole('button', { name: 'Salvar' });
    const destructive = screen.getByRole('button', { name: 'Remover' });

    expect(primary.className.split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-button--primary', 'ui-button--md']));
    expect(primary.getAttribute('type')).toBe('button');
    expect(destructive.className.split(' ')).toEqual(expect.arrayContaining(['ui-button--destructive', 'ui-button--lg']));
  });

  it('disables a loading button and marks it busy, even when disabled={false} is passed', () => {
    render(<Button loading disabled={false}>Enviar</Button>);
    const button = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.classList.contains('ui-button--loading')).toBe(true);
  });

  it('is neither busy nor disabled without loading, and keeps an explicit disabled', () => {
    render(<><Button>Livre</Button><Button disabled>Travado</Button></>);

    const free = screen.getByRole('button', { name: 'Livre' }) as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    expect(free.hasAttribute('aria-busy')).toBe(false);
    expect((screen.getByRole('button', { name: 'Travado' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
