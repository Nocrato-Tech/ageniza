// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ArrowRight, Plus } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as ui from './index.js';
import { Button, IconButton, Pill, PillAction } from './index.js';

afterEach(cleanup);

describe('exports', () => {
  it('never take the name of a JS global, which a consumer would silently shadow', () => {
    const shadowing = Object.keys(ui).filter((name) => name in globalThis);

    expect(shadowing).toEqual([]);
  });
});

describe('Button with an icon', () => {
  it('puts the icon before and after the label and keeps the label as the whole name', () => {
    render(<Button leadingIcon={<Plus />} trailingIcon={<ArrowRight />}>Nova publicação</Button>);
    const button = screen.getByRole('button', { name: 'Nova publicação' });
    const slots = button.querySelectorAll('.ui-icon');

    expect(slots).toHaveLength(2);
    expect(button.firstElementChild).toBe(slots[0]);
    expect(button.lastElementChild).toBe(slots[1]);
    expect(button.querySelector('.ui-button__label')?.textContent).toBe('Nova publicação');
    slots.forEach((slot) => expect(slot.getAttribute('aria-hidden')).toBe('true'));
  });

  it('draws no icon slot when none is given', () => {
    render(<Button>Salvar</Button>);

    expect(screen.getByRole('button', { name: 'Salvar' }).querySelector('.ui-icon')).toBeNull();
  });

  it('does not act while loading, keeps its name and cannot take focus', () => {
    const onClick = vi.fn();
    render(<Button loading leadingIcon={<Plus />} onClick={onClick}>Enviar</Button>);
    const button = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('can take keyboard focus while idle and acts on a click', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Salvar</Button>);
    const button = screen.getByRole('button', { name: 'Salvar' });

    button.focus();
    fireEvent.click(button);

    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not act when disabled and cannot take focus', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Salvar</Button>);
    const button = screen.getByRole('button', { name: 'Salvar' });

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
  });
});

describe('IconButton', () => {
  it('is named by its label, shows it as the tooltip and hides the glyph', () => {
    render(<IconButton label="Fechar" icon={<Plus />} />);
    const button = screen.getByRole('button', { name: 'Fechar' });

    expect(button.getAttribute('aria-label')).toBe('Fechar');
    expect(button.getAttribute('title')).toBe('Fechar');
    expect(button.textContent).toBe('');
    expect(button.querySelector('.ui-button__label')).toBeNull();
    expect(button.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-button', 'ui-icon-button', 'ui-button--ghost', 'ui-button--md']));
  });

  it('takes a variant and a size like a button', () => {
    render(<IconButton label="Adicionar" icon={<Plus />} variant="primary" size="sm" />);

    expect(screen.getByRole('button', { name: 'Adicionar' }).className.split(' ')).toEqual(
      expect.arrayContaining(['ui-button--primary', 'ui-button--sm'])
    );
  });

  it('keeps its name while loading and then neither acts nor takes focus', () => {
    const onClick = vi.fn();
    render(<IconButton label="Adicionar" icon={<Plus />} loading onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('takes keyboard focus and acts on a click while idle', () => {
    const onClick = vi.fn();
    render(<IconButton label="Adicionar" icon={<Plus />} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Adicionar' });

    button.focus();
    fireEvent.click(button);

    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Pill', () => {
  it('is a static capsule with its text, an optional hidden icon and a tone', () => {
    render(<Pill tone="accent" icon={<Plus />} data-testid="pill">24</Pill>);
    const pill = screen.getByTestId('pill');

    expect(pill.tagName).toBe('SPAN');
    expect(pill.textContent).toBe('24');
    expect(pill.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill', 'ui-pill--accent']));
    expect(pill.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is neutral by default', () => {
    render(<Pill data-testid="pill">3</Pill>);

    expect(screen.getByTestId('pill').className.split(' ')).toContain('ui-pill--neutral');
  });
});

describe('PillAction', () => {
  it('is a non-submitting button named by its label, with the icon outside the name', () => {
    const onClick = vi.fn();
    render(<PillAction trailingIcon={<ArrowRight />} onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' });

    button.focus();
    fireEvent.click(button);

    expect(button.getAttribute('type')).toBe('button');
    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill', 'ui-pill--action', 'ui-pill--neutral']));
    expect(button.querySelector('.ui-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not act when disabled and cannot take focus', () => {
    const onClick = vi.fn();
    render(<PillAction disabled onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' });

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
  });

  it('keeps its name while loading, then marks itself busy and neither acts nor takes focus', () => {
    const onClick = vi.fn();
    render(<PillAction loading tone="accent" onClick={onClick}>Abrir</PillAction>);
    const button = screen.getByRole('button', { name: 'Abrir' }) as HTMLButtonElement;

    fireEvent.click(button);
    button.focus();

    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['ui-pill--loading', 'ui-pill--accent']));
  });
});
