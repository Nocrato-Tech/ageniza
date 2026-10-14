import { type SelectHTMLAttributes } from 'react';

import { Field, type FieldProps } from './field.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children'>, Pick<FieldProps, 'hint' | 'error' | 'loading'> {
  /** Visible label, bound to the control, so the filter is never an unlabelled box. */
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Option shown when no value is chosen; its value is empty, meaning "no filter". */
  placeholder?: string;
}

/** A labelled native select: the platform owns the popup, keyboard and screen-reader behavior. */
export function Select({ label, hint, error, loading, value, options, onChange, placeholder, id, className, disabled, ...props }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} loading={loading} id={id} className={className}>
      {(control) => (
        <select
          {...control}
          {...props}
          aria-describedby={[control['aria-describedby'], props['aria-describedby']].filter(Boolean).join(' ') || undefined}
          aria-invalid={control['aria-invalid'] ?? props['aria-invalid']}
          className="ui-select"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    </Field>
  );
}
