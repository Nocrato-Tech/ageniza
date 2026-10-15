import { useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

import { IconSlot } from './icon.js';

/** What the control must spread on itself so the label, hint, counter and error reach assistive technology. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-busy'?: true;
}

export interface FieldProps {
  /** Visible label, bound to the control by `htmlFor`. */
  label: string;
  hint?: string;
  /** Names the problem and how to leave it; it also marks the control invalid. */
  error?: string;
  /** Characters used and allowed; going over marks the control invalid even without an `error`. */
  counter?: { count: number; max: number };
  /** A check in progress (e.g. the e-mail is being validated): the control stays editable and says it is busy. */
  loading?: boolean;
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** Label, hint, counter and error around any control: `<Field label="Título">{(control) => <TextInput {...control} />}</Field>`. */
export function Field({ label, hint, error, counter, loading = false, id, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const over = counter !== undefined && counter.count > counter.max;
  const hintId = `${controlId}-hint`;
  const counterId = `${controlId}-counter`;
  const errorId = `${controlId}-error`;
  const described = [hint !== undefined && hintId, counter !== undefined && counterId, error !== undefined && errorId].filter(Boolean).join(' ');

  return (
    <div className={['ui-field', loading && 'ui-field--loading', className].filter(Boolean).join(' ')}>
      <label className="ui-field__label" htmlFor={controlId}>{label}</label>
      {children({
        id: controlId,
        'aria-describedby': described === '' ? undefined : described,
        'aria-invalid': error !== undefined || over ? true : undefined,
        'aria-busy': loading ? true : undefined
      })}
      {(hint !== undefined || counter !== undefined) && (
        <div className="ui-field__meta">
          {hint !== undefined && <p id={hintId} className="ui-field__hint">{hint}</p>}
          {counter !== undefined && (
            <span id={counterId} className={['ui-field__counter', over && 'ui-field__counter--over'].filter(Boolean).join(' ')}>
              {over && <IconSlot><CircleAlert /></IconSlot>}
              {counter.count}/{counter.max}
            </span>
          )}
        </div>
      )}
      {error !== undefined && (
        <p id={errorId} className="ui-field-message" role="alert">
          <IconSlot><CircleAlert /></IconSlot>
          {error}
        </p>
      )}
    </div>
  );
}
