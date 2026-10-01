import { useId, type SelectHTMLAttributes } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children'> {
  /** Visible label, bound to the control, so the filter is never an unlabelled box. */
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Option shown when no value is chosen; its value is empty, meaning "no filter". */
  placeholder?: string;
}

/** A labelled native select: the platform owns the popup, keyboard and screen-reader behavior. */
export function Select({ label, value, options, onChange, placeholder, id, className, disabled, ...props }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  return (
    <div className={['ui-field', className].filter(Boolean).join(' ')}>
      <label className="ui-field__label" htmlFor={selectId}>{label}</label>
      <select
        {...props}
        id={selectId}
        className="ui-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}
