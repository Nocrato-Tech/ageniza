import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export interface TableColumn<Row> {
  /** Stable id of the column. */
  key: string;
  /** The header text; it names the column for assistive technology even on the phone, where the header row is not drawn. */
  header: string;
  render: (row: Row) => ReactNode;
  /** The grid track of the column (a `fr`, `rem` or `minmax` value); the default shares the room. */
  width?: string;
  /** Stays when the table turns into a list on a phone. The first column always stays: it is the row's name. */
  keepOnPhone?: boolean;
}

export interface TableProps<Row> {
  /** Names the table for assistive technology. */
  label: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The row that is chosen now (the file whose details are open). */
  selectedKey?: string | null;
  /** Makes the first column of each row a button that chooses it. Then that column must hold no link or button of its own. */
  onSelect?: (row: Row) => void;
  /** The actions of a row, as the last cell (usually a `Menu` of "Ações"): the owner brings the control, the table only holds its place. */
  actions?: (row: Row) => ReactNode;
  /** Names the actions column. */
  actionsLabel?: string;
  /** What the body says when there is no row. */
  empty?: ReactNode;
  className?: string;
}

const ACTIONS_WIDTH = '2.75rem';

/**
 * A table in a card: header, rows that rise on hover, the chosen row tinted, and a cell of actions. On a phone the header goes
 * and each row becomes a list item with the name and the columns marked `keepOnPhone`. It uses table roles on a grid, so it can
 * reflow; with `onSelect`, the name of each row is a button (Tab, Enter and Space) and the arrow keys, Home and End walk between them.
 */
export function Table<Row>({ label, columns, rows, rowKey, selectedKey, onSelect, actions, actionsLabel = 'Ações', empty, className }: TableProps<Row>) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const tracks = [...columns.map((column) => column.width ?? 'minmax(0, 1fr)'), ...(actions === undefined ? [] : [ACTIONS_WIDTH])].join(' ');
  const style = { '--ui-table-columns': tracks } as CSSProperties;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches('.ui-table__select')) return;
    const buttons = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('.ui-table__select') ?? []);
    const current = buttons.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1);
    const target = buttons[next];
    if (target === undefined) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div role="table" aria-label={label} aria-rowcount={rows.length + 1} className={['ui-table', className].filter(Boolean).join(' ')} style={style}>
      <div role="rowgroup" className="ui-table__head">
        <div role="row" className="ui-table__row ui-table__row--head">
          {columns.map((column) => <span key={column.key} role="columnheader" className="ui-table__heading">{column.header}</span>)}
          {actions !== undefined && <span role="columnheader" className="ui-table__heading ui-table__heading--actions"><span className="ui-table__sr">{actionsLabel}</span></span>}
        </div>
      </div>
      <div ref={bodyRef} role="rowgroup" className="ui-table__body" onKeyDown={onKeyDown}>
        {rows.length === 0 && empty !== undefined && <div role="row" className="ui-table__empty"><span role="cell">{empty}</span></div>}
        {rows.map((row, rowIndex) => {
          const key = rowKey(row);
          const selected = selectedKey === key;
          return (
            <div key={key} role="row" aria-rowindex={rowIndex + 2} aria-selected={onSelect === undefined ? undefined : selected} className={['ui-table__row', selected && 'ui-table__row--selected'].filter(Boolean).join(' ')}>
              {columns.map((column, index) => (
                <span key={column.key} role="cell" className={['ui-table__cell', index === 0 ? 'ui-table__cell--name' : column.keepOnPhone === true && 'ui-table__cell--keep'].filter(Boolean).join(' ')}>
                  {index === 0 && onSelect !== undefined
                    ? <button type="button" className="ui-table__select" aria-current={selected || undefined} onClick={() => onSelect(row)}>{column.render(row)}</button>
                    : column.render(row)}
                </span>
              ))}
              {actions !== undefined && <span role="cell" className="ui-table__cell ui-table__cell--actions">{actions(row)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
