// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button, ChoiceCard, ConfirmDialog, Menu, MenuItem, MenuSeparator, Skeleton } from './index.js';

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

describe('Menu', () => {
  it('opens from the trigger and supports keyboard focus and Escape', () => {
    render(
      <Menu label='Account menu' trigger='Open account'>
        <MenuItem>First action</MenuItem>
        <MenuItem>Second action</MenuItem>
      </Menu>
    );

    const trigger = screen.getByRole('button', { name: 'Open account' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    const first = screen.getByRole('menuitem', { name: 'First action' });
    const second = screen.getByRole('menuitem', { name: 'Second action' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('exposes a separated destructive menu action', () => {
    render(
      <Menu label='Menu' trigger='Open'>
        <MenuItem>Normal</MenuItem>
        <MenuSeparator />
        <MenuItem variant='destructive'>Dangerous action</MenuItem>
      </Menu>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Dangerous action' }).className).toContain('ui-menu-item--destructive');
  });

  it('reports open and close through onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      <Menu label='Menu' trigger='Open' onOpenChange={onOpenChange}>
        <MenuItem>Only action</MenuItem>
      </Menu>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Only action' }), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('moves focus to the first item when the active panel changes', () => {
    const { rerender } = render(
      <Menu label='Menu' trigger='Open' activePanel='root'>
        <MenuItem>Root action</MenuItem>
      </Menu>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Root action' }));

    // The first child changes type, so React drops the focused button instead of reusing it; only the
    // panel change can move focus back onto the new first item.
    rerender(
      <Menu label='Menu' trigger='Open' activePanel='switch'>
        <MenuSeparator />
        <MenuItem>Back</MenuItem>
      </Menu>
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Back' }));
  });
});

describe('ConfirmDialog', () => {
  it('is modal, focuses cancel, and closes on Escape', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title='End all sessions?'
        description='You will need to sign in again.'
        confirmLabel='End all sessions'
        cancelLabel='Cancel'
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );

    const dialog = screen.getByRole('dialog', { name: 'End all sessions?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
