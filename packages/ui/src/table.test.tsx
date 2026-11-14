// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Table, type TableColumn } from './index.js';

afterEach(cleanup);

interface Row { id: string; name: string; kind: string; sent: string }
const ROWS: readonly Row[] = [
  { id: 'a', name: 'fachada-natal.jpg', kind: 'Foto', sent: '10 nov' },
  { id: 'b', name: 'cardapio-natal-2026.pdf', kind: 'PDF', sent: '10 nov' },
  { id: 'c', name: 'forno-novo.mp4', kind: 'Vídeo', sent: '9 nov' }
];
const COLUMNS: readonly TableColumn<Row>[] = [
  { key: 'name', header: 'Nome', width: 'minmax(0, 2fr)', render: (row) => <span>{row.name}</span> },
  { key: 'kind', header: 'Tipo', width: '6rem', render: (row) => row.kind },
  { key: 'sent', header: 'Enviado', keepOnPhone: true, render: (row) => row.sent }
];

function Harness({ onPick, withActions = false }: { onPick?: (row: Row) => void; withActions?: boolean }) {
  const [selected, setSelected] = useState<string | null>('b');
  return <Table<Row>
    label="Arquivos recentes"
    columns={COLUMNS}
    rows={ROWS}
    rowKey={(row) => row.id}
    selectedKey={selected}
    onSelect={(row) => { setSelected(row.id); onPick?.(row); }}
    {...(withActions ? { actions: (row: Row) => <button type="button" aria-label={`Ações de ${row.name}`}>⋮</button> } : {})}
  />;
}

describe('Table structure', () => {
  it('is a named table with a header row and one row per item, each cell under its header', () => {
    render(<Table<Row> label="Arquivos recentes" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    const table = screen.getByRole('table', { name: 'Arquivos recentes' });

    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Nome', 'Tipo', 'Enviado']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(within(table).getAllByRole('row')[2]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['cardapio-natal-2026.pdf', 'PDF', '10 nov']);
  });

  it('lays the columns on the tracks they ask for, sharing the room when none is given', () => {
    render(<Table<Row> label="Arquivos" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    expect(screen.getByRole('table').style.getPropertyValue('--ui-table-columns')).toBe('minmax(0, 2fr) 6rem minmax(0, 1fr)');
  });

  it('is read-only without onSelect: no buttons, no selection state', () => {
    render(<Table<Row> label="Arquivos" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} selectedKey="b" />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('row').some((row) => row.hasAttribute('aria-selected'))).toBe(false);
  });

  it('marks the first column as the name and keeps the columns that stay on a phone', () => {
    const { container } = render(<Table<Row> label="Arquivos" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);
    const cells = Array.from(container.querySelectorAll('.ui-table__body [role=row]:first-child [role=cell]'));

    expect(cells.map((cell) => cell.className)).toEqual([
      'ui-table__cell ui-table__cell--name',
      'ui-table__cell',
      'ui-table__cell ui-table__cell--keep'
    ]);
  });

  it('says there is nothing when there are no rows, inside a row of its own so the roles stay valid', () => {
    render(<Table<Row> label="Arquivos" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} empty="Nenhum arquivo enviado ainda." />);

    expect(within(screen.getByText('Nenhum arquivo enviado ainda.').closest('[role=row]') as HTMLElement).getByRole('cell').textContent).toBe('Nenhum arquivo enviado ainda.');
    expect(screen.getByText('Nenhum arquivo enviado ainda.').closest('[role=rowgroup]')).not.toBeNull();
  });
});

describe('Table selection and keyboard', () => {
  it('makes the name of each row a button, marks the chosen row and the button of it as current', () => {
    render(<Harness />);
    const chosen = screen.getByRole('button', { name: 'cardapio-natal-2026.pdf' });

    expect(chosen.getAttribute('aria-current')).toBe('true');
    expect(chosen.closest('[role=row]')!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'fachada-natal.jpg' }).hasAttribute('aria-current')).toBe(false);
    expect(screen.getByRole('button', { name: 'fachada-natal.jpg' }).closest('[role=row]')!.getAttribute('aria-selected')).toBe('false');
  });

  it('chooses a row on click, which moves the selection', () => {
    const pick = vi.fn();
    render(<Harness onPick={pick} />);

    fireEvent.click(screen.getByRole('button', { name: 'forno-novo.mp4' }));

    expect(pick).toHaveBeenCalledWith(ROWS[2]);
    expect(screen.getByRole('button', { name: 'forno-novo.mp4' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'cardapio-natal-2026.pdf' }).hasAttribute('aria-current')).toBe(false);
  });

  it('is a native button, so Tab reaches it and Enter and Space (a click) choose it', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'fachada-natal.jpg' }) as HTMLButtonElement;

    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('walks between the row buttons with the arrow keys, Home and End, without choosing or wrapping', () => {
    const pick = vi.fn();
    render(<Harness onPick={pick} />);
    const [first, second, third] = ['fachada-natal.jpg', 'cardapio-natal-2026.pdf', 'forno-novo.mp4'].map((name) => screen.getByRole('button', { name }));

    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'End' });
    expect(document.activeElement).toBe(third);
    expect(fireEvent.keyDown(third!, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first!, { key: 'ArrowUp' })).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(pick).not.toHaveBeenCalled();
  });

  it('ignores other keys and keys pressed on something that is not a row button', () => {
    render(<Harness withActions />);
    const first = screen.getByRole('button', { name: 'fachada-natal.jpg' });
    const action = screen.getByRole('button', { name: 'Ações de fachada-natal.jpg' });

    first.focus();
    expect(fireEvent.keyDown(first, { key: 'a' })).toBe(true);
    action.focus();
    expect(fireEvent.keyDown(action, { key: 'ArrowDown' })).toBe(true);
    expect(document.activeElement).toBe(action);
  });
});

describe('Table row actions', () => {
  it('holds a cell of actions per row, with its column named for assistive technology and no visible heading', () => {
    render(<Harness withActions />);
    const table = screen.getByRole('table');

    expect(within(table).getByRole('columnheader', { name: 'Ações' })).toBeTruthy();
    expect(within(table).getAllByRole('button', { name: /^Ações de / })).toHaveLength(3);
    expect(table.style.getPropertyValue('--ui-table-columns')).toBe('minmax(0, 2fr) 6rem minmax(0, 1fr) 2.75rem');
  });

  it('leaves out the actions column when there are no actions', () => {
    render(<Harness />);

    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
  });

  it('names the actions column as asked', () => {
    render(<Table<Row> label="Arquivos" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} actionsLabel="Mais" actions={() => <span>x</span>} />);

    expect(screen.getByRole('columnheader', { name: 'Mais' })).toBeTruthy();
  });

  it('keeps a click on an action from choosing the row', () => {
    const pick = vi.fn();
    render(<Harness onPick={pick} withActions />);

    fireEvent.click(screen.getByRole('button', { name: 'Ações de forno-novo.mp4' }));

    expect(pick).not.toHaveBeenCalled();
  });
});
