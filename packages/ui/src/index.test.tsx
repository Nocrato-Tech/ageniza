// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Avatar, BadgeCard, Button, ChoiceCard, ConfirmDialog, Menu, MenuItem, MenuSeparator, Pagination, Select, Skeleton } from './index.js';

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

  it('moves focus to a first item that arrives after opening, while the person has not moved', () => {
    const { rerender } = render(
      <Menu label='Menu' trigger='Open' activePanel='root'>
        <MenuItem key='sair'>Sair</MenuItem>
      </Menu>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sair' }));

    // Keys keep the focused button in the DOM while a new first item is inserted before it.
    rerender(
      <Menu label='Menu' trigger='Open' activePanel='root'>
        <MenuItem key='trocar'>Trocar</MenuItem>
        <MenuItem key='sair'>Sair</MenuItem>
      </Menu>
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Trocar' }));
  });

  it('does not pull focus back to the first item when the person has already moved', () => {
    const { rerender } = render(
      <Menu label='Menu' trigger='Open' activePanel='root'>
        <MenuItem key='sair'>Sair</MenuItem>
        <MenuItem key='outra'>Outra</MenuItem>
      </Menu>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Sair' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Outra' }));

    rerender(
      <Menu label='Menu' trigger='Open' activePanel='root'>
        <MenuItem key='trocar'>Trocar</MenuItem>
        <MenuItem key='sair'>Sair</MenuItem>
        <MenuItem key='outra'>Outra</MenuItem>
      </Menu>
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Outra' }));
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

describe('Avatar', () => {
  it('shows the initials of the first and last name when there is no photo', () => {
    const { container } = render(<Avatar name="Mário Costa" />);
    expect(screen.getByText('MC')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses one letter for a single name', () => {
    render(<Avatar name="Ana" />);
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('shows the photo instead of the initials when a photo URL exists', () => {
    const { container } = render(<Avatar name="Júlia Reis" photoUrl="https://example.test/photo.png" />);
    const photo = container.querySelector('img.ui-avatar__photo');
    expect(photo?.getAttribute('src')).toBe('https://example.test/photo.png');
    expect(screen.queryByText('JR')).toBeNull();
  });
});

describe('BadgeCard', () => {
  it('shows name, job title and role', () => {
    const { container } = render(<BadgeCard name="Ana Prado" photoUrl={null} jobTitle="Editora" role="Produção" />);
    expect(screen.getByText('Ana Prado')).toBeTruthy();
    expect(screen.getByText('Editora')).toBeTruthy();
    expect(screen.getByText('Produção')).toBeTruthy();
    expect(container.querySelector('.ui-badge-card__job')).not.toBeNull();
  });

  it('omits the job title line when there is none', () => {
    const { container } = render(<BadgeCard name="Mário Costa" photoUrl={null} jobTitle={null} role="Gestor de conta" />);
    expect(container.querySelector('.ui-badge-card__job')).toBeNull();
    expect(screen.getByText('Gestor de conta')).toBeTruthy();
  });

  it('says the link ended only on a removed badge', () => {
    const { container } = render(<BadgeCard name="Paulo Lima" photoUrl={null} jobTitle="Motion" role="Produção" removed />);
    expect(screen.getByText('removido')).toBeTruthy();
    expect(container.querySelector('.ui-badge-card__removed')).not.toBeNull();

    cleanup();
    render(<BadgeCard name="Ana Prado" photoUrl={null} jobTitle="Editora" role="Produção" />);
    expect(screen.queryByText('removido')).toBeNull();
  });
});

describe('Select', () => {
  it('renders a labelled native select and reports changes', () => {
    const onChange = vi.fn();
    render(<Select
      label='Papel'
      value='production'
      options={[{ value: 'production', label: 'Produção' }, { value: 'admin', label: 'Admin' }]}
      onChange={onChange}
      placeholder='Todos os papéis'
    />);

    const select = screen.getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement;
    expect(select.value).toBe('production');
    expect(screen.getByRole('option', { name: 'Todos os papéis' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'admin' } });
    expect(onChange).toHaveBeenCalledWith('admin');
  });
});

describe('Pagination', () => {
  it('marks the current page, shows the count and reports navigation', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} totalPages={3} onPageChange={onPageChange} summary="24 de 61 pessoas" />);

    expect(screen.getByRole('button', { name: 'Página 2' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('24 de 61 pessoas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Página 3' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('collapses a long range with gaps and disables the step at the first page', () => {
    render(<Pagination page={1} totalPages={20} onPageChange={vi.fn()} />);

    expect((screen.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Página 1' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Página 20' })).toBeTruthy();
    expect(document.querySelectorAll('.ui-pagination__gap').length).toBeGreaterThan(0);
  });

  it('renders nothing when there is a single page and no count', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onPageChange={vi.fn()} />);
    expect(container.querySelector('.ui-pagination')).toBeNull();
  });
});
