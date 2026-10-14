// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientStrip, FilterBar, FilterBarItem, FilterBarSelect, type ClientStripItem } from './index.js';

afterEach(cleanup);

const CLIENTS: readonly ClientStripItem[] = [
  { id: 'c1', name: 'Padaria Central', href: '/clientes/c1' },
  { id: 'c2', name: 'Clínica Viver Bem', href: '/clientes/c2', attention: ['em ajuste', 'em atraso'] },
  { id: 'c3', name: 'Café do Alto', href: '/clientes/c3', photoUrl: 'https://example.test/cafe.png' }
];

const links = (): HTMLElement[] => within(screen.getByRole('navigation', { name: 'Clientes' })).getAllByRole('link');

describe('ClientStrip', () => {
  it('is a navigation named by its label, with one real link per client in the order given', () => {
    render(<ClientStrip label="Clientes" items={CLIENTS} />);

    expect(links().map((link) => link.getAttribute('href'))).toEqual(['/clientes/c1', '/clientes/c2', '/clientes/c3']);
    expect(links()[0]!.textContent).toBe('PCPadaria Central');
  });

  it('shows the initials, or the photo as a decorative image', () => {
    const { container } = render(<ClientStrip label="Clientes" items={CLIENTS} />);

    expect(within(links()[0]!).getByText('PC').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/cafe.png');
  });

  it('marks only the client you are on, with the page marker and the highlighter on the name', () => {
    render(<ClientStrip label="Clientes" items={CLIENTS} selectedId="c2" />);

    expect(links().map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(links()[1]!.querySelector('.ui-realce')?.textContent).toBe('Clínica Viver Bem');
    expect(links()[0]!.querySelector('.ui-realce')).toBeNull();
    expect(links()[2]!.querySelector('.ui-realce')).toBeNull();
  });

  it('marks nobody when no client is chosen', () => {
    const { container } = render(<ClientStrip label="Clientes" items={CLIENTS} />);

    expect(container.querySelector('[aria-current]')).toBeNull();
    expect(container.querySelector('.ui-realce')).toBeNull();
  });

  it('rings only the client that asks for action, and says why after the name, so the name still holds the visible text', () => {
    const { container } = render(<ClientStrip label="Clientes" items={CLIENTS} />);

    expect(screen.getByRole('link', { name: 'Clínica Viver Bem, em ajuste, em atraso' })).toBeTruthy();
    expect(container.querySelectorAll('.ui-avatar--attention')).toHaveLength(1);
    expect(links()[1]!.querySelector('.ui-avatar--attention')).not.toBeNull();
    expect(links()[0]!.getAttribute('aria-label')).toBeNull();
    expect(links()[2]!.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('link', { name: 'Padaria Central' })).toBeTruthy();
  });

  it('draws no ring for an empty list of reasons', () => {
    const { container } = render(<ClientStrip label="Clientes" items={[{ id: 'c1', name: 'Padaria Central', href: '/x', attention: [] }]} />);

    expect(container.querySelector('.ui-avatar--attention')).toBeNull();
    expect(links()[0]!.getAttribute('aria-label')).toBeNull();
  });

  it('puts every link in the tab order, in the order of the strip', () => {
    render(<ClientStrip label="Clientes" items={CLIENTS} />);

    for (const link of links()) {
      link.focus();
      expect(document.activeElement).toBe(link);
      expect(link.getAttribute('tabindex')).toBeNull();
    }
  });

  it('lets the screen draw the links with its router, keeping the look, the marker and the name', () => {
    const renderLink = vi.fn((item: ClientStripItem, link: Record<string, unknown>) => {
      const { children, ...rest } = link;
      return <a href={`/app/${item.id}`} data-router="yes" {...rest}>{children as never}</a>;
    });
    render(<ClientStrip label="Clientes" items={CLIENTS} selectedId="c1" renderLink={renderLink as never} />);

    expect(renderLink).toHaveBeenCalledTimes(3);
    expect(links().map((link) => link.getAttribute('href'))).toEqual(['/app/c1', '/app/c2', '/app/c3']);
    expect(links().every((link) => link.getAttribute('data-router') === 'yes')).toBe(true);
    expect(links().every((link) => link.className === 'ui-client-strip__item')).toBe(true);
    expect(links()[0]!.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Clínica Viver Bem, em ajuste, em atraso' })).toBeTruthy();
  });

  it('keeps the class of the screen on the navigation', () => {
    render(<ClientStrip label="Clientes" items={CLIENTS} className="contents__strip" />);

    expect(screen.getByRole('navigation', { name: 'Clientes' }).className).toBe('ui-client-strip contents__strip');
  });
});

describe('FilterBar', () => {
  const MONTHS = [{ value: '10', label: 'Outubro' }, { value: '11', label: 'Novembro' }];

  it('is a group named by its label, holding the filters', () => {
    render(<FilterBar label="Filtros do calendário"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} /></FilterBar>);

    expect(within(screen.getByRole('group', { name: 'Filtros do calendário' })).getByRole('combobox', { name: 'Mês' })).toBeTruthy();
  });

  it('puts the label above the choice and binds them', () => {
    render(<FilterBar label="Filtros"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} /></FilterBar>);
    const select = screen.getByLabelText('Mês') as HTMLSelectElement;
    const label = screen.getByText('Mês');

    expect(label.tagName).toBe('LABEL');
    expect(label.className).toBe('ui-filter-bar__label');
    expect(label.nextElementSibling).toBe(select);
    expect(select.className).toBe('ui-filter-bar__control');
    expect(select.value).toBe('10');
  });

  it('reports the value chosen, and only for the filter that changed', () => {
    const onMonth = vi.fn();
    const onClient = vi.fn();
    render(<FilterBar label="Filtros">
      <FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={onMonth} />
      <FilterBarSelect label="Cliente" value="" placeholder="Todos" options={[{ value: 'a', label: 'Padaria' }]} onChange={onClient} />
    </FilterBar>);

    fireEvent.change(screen.getByLabelText('Cliente'), { target: { value: 'a' } });

    expect(onClient).toHaveBeenCalledWith('a');
    expect(onMonth).not.toHaveBeenCalled();
  });

  it('offers the empty option as "no filter" when it has a placeholder, and not otherwise', () => {
    render(<FilterBar label="Filtros">
      <FilterBarSelect label="Cliente" value="" placeholder="Todos" options={[{ value: 'a', label: 'Padaria' }]} onChange={() => undefined} />
      <FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} />
    </FilterBar>);

    expect(within(screen.getByLabelText('Cliente')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'a']);
    expect(within(screen.getByLabelText('Mês')).getAllByRole('option')).toHaveLength(2);
  });

  it('gives every filter its own label and control, even with the same wording elsewhere', () => {
    render(<FilterBar label="Filtros">
      <FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} />
      <FilterBarSelect label="Ano" value="2026" options={[{ value: '2026', label: '2026' }]} onChange={() => undefined} />
    </FilterBar>);

    expect(screen.getByLabelText('Mês').id).not.toBe(screen.getByLabelText('Ano').id);
  });

  it('cannot be changed while disabled', () => {
    render(<FilterBar label="Filtros"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} disabled /></FilterBar>);

    expect((screen.getByLabelText('Mês') as HTMLSelectElement).disabled).toBe(true);
  });

  it('says it is busy while loading and stays usable, keeping the keyboard focus', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FilterBar label="Filtros"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={onChange} /></FilterBar>);
    const select = screen.getByLabelText('Mês') as HTMLSelectElement;
    select.focus();

    rerender(<FilterBar label="Filtros"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={onChange} loading /></FilterBar>);
    fireEvent.change(select, { target: { value: '11' } });

    expect(select.getAttribute('aria-busy')).toBe('true');
    expect(select.disabled).toBe(false);
    expect(document.activeElement).toBe(select);
    expect(onChange).toHaveBeenCalledWith('11');
    expect(select.closest('.ui-filter-bar__item')?.classList.contains('ui-filter-bar__item--loading')).toBe(true);
  });

  it('is not busy when it is not loading', () => {
    render(<FilterBar label="Filtros"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} /></FilterBar>);

    expect(screen.getByLabelText('Mês').getAttribute('aria-busy')).toBeNull();
  });

  it('takes any control in a FilterBarItem and binds the label to it', () => {
    render(<FilterBar label="Filtros">
      <FilterBarItem label="Buscar">{(control) => <input {...control} defaultValue="pão" />}</FilterBarItem>
    </FilterBar>);
    const input = screen.getByLabelText('Buscar') as HTMLInputElement;

    expect(input.value).toBe('pão');
    expect(input.className).toBe('ui-filter-bar__control');
  });

  it('keeps the class of the screen on the group', () => {
    render(<FilterBar label="Filtros" className="calendar__filters"><FilterBarSelect label="Mês" value="10" options={MONTHS} onChange={() => undefined} /></FilterBar>);

    expect(screen.getByRole('group', { name: 'Filtros' }).className).toBe('ui-filter-bar calendar__filters');
  });
});
