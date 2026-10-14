import { useId, type ReactNode } from 'react';

import type { SelectOption } from './select.js';

export interface FilterBarProps {
  /** Names the group of filters for assistive technology ("Filtros do calendário"). */
  label: string;
  children: ReactNode;
  className?: string;
}

/** A row of filters, each with its label above and its choice below, split by dividers; on a phone they stack. */
export function FilterBar({ label, children, className }: FilterBarProps) {
  return <div role="group" aria-label={label} className={['ui-filter-bar', className].filter(Boolean).join(' ')}>{children}</div>;
}

/** What the control inside a `FilterBarItem` must spread on itself so its label reaches assistive technology. */
export interface FilterBarControlProps {
  id: string;
  className: string;
  'aria-busy'?: true;
}

export interface FilterBarItemProps {
  /** Visible label above the choice, bound to the control by `htmlFor`. */
  label: string;
  /** A check in progress: the control stays usable and the label says it is busy. */
  loading?: boolean;
  id?: string;
  children: (control: FilterBarControlProps) => ReactNode;
}

/** One filter of the bar: `<FilterBarItem label="Mês">{(control) => <select {...control}>…</select>}</FilterBarItem>`. */
export function FilterBarItem({ label, loading = false, id, children }: FilterBarItemProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <div className={['ui-filter-bar__item', loading && 'ui-filter-bar__item--loading'].filter(Boolean).join(' ')}>
      <label className="ui-filter-bar__label" htmlFor={controlId}>{label}</label>
      {children({ id: controlId, className: 'ui-filter-bar__control', 'aria-busy': loading ? true : undefined })}
    </div>
  );
}

export interface FilterBarSelectProps {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Option shown when nothing is chosen; its value is empty, meaning "no filter". */
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
}

/** The usual filter: a native select, so the platform owns the popup, the keyboard and the screen reader. */
export function FilterBarSelect({ label, value, options, onChange, placeholder, disabled = false, loading = false }: FilterBarSelectProps) {
  return (
    <FilterBarItem label={label} loading={loading}>
      {(control) => (
        <select {...control} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    </FilterBarItem>
  );
}
