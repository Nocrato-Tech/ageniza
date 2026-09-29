// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, ChoiceCard, Skeleton } from './index.js';

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

describe('ChoiceCard', () => {
  it('exposes the whole card as a non-submitting button with title and description', () => {
    render(<ChoiceCard title="Agência A" description="Área da agência · Admin" />);
    const card = screen.getByRole('button', { name: /Agência A/ });

    expect(card.getAttribute('type')).toBe('button');
    expect(card.className.split(' ')).not.toContain('ui-choice-card--highlighted');
    expect(card.textContent).toContain('Área da agência · Admin');
  });

  it('marks only a highlighted card, and never selects on its own', () => {
    render(<><ChoiceCard title="A" description="x" /><ChoiceCard title="B" description="y" highlighted /></>);

    expect(screen.getByRole('button', { name: /A/ }).classList.contains('ui-choice-card--highlighted')).toBe(false);
    expect(screen.getByRole('button', { name: /B/ }).classList.contains('ui-choice-card--highlighted')).toBe(true);
  });

  it('keeps an explicit disabled state', () => {
    render(<ChoiceCard title="A" description="x" disabled />);
    expect((screen.getByRole('button', { name: /A/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Skeleton', () => {
  it('is decorative and never announced', () => {
    render(<Skeleton data-testid="skeleton" />);
    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.className.split(' ')).toContain('ui-skeleton');
  });
});
