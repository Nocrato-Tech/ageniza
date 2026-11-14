import { useId, type CSSProperties, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

import { IconSlot } from './icon.js';

/** What the control must spread on itself so the label, hint, counter and error reach assistive technology. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-busy'?: true;
}

/** The share of the limit from which the counter starts to speak to assistive technology. */
const COUNTER_WARNING = 0.9;

export interface FieldCounter {
  count: number;
  max: number;
  /** `slash` reads "52/280"; `of` reads "52 de 280", the board's wording. */
  format?: 'slash' | 'of';
}

export interface FieldProps {
  /** Visible label, bound to the control by `htmlFor`. */
  label: string;
  hint?: string;
  /** Names the problem and how to leave it; it also marks the control invalid. */
  error?: string;
  /** Characters used and allowed; going over marks the control invalid even without an `error`. */
  counter?: FieldCounter;
  /** The unit that closes the control, inside its edge ("horas"); it describes the control, so it is read after the label. */
  suffix?: string;
  /** A check in progress (e.g. the e-mail is being validated): the control stays editable and says it is busy. */
  loading?: boolean;
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** What the counter says aloud: nothing while there is room, so typing is not read letter by letter. */
const spoken = ({ count, max }: FieldCounter): string => {
  if (count > max) return `Passou do limite em ${count - max} ${count - max === 1 ? 'caractere' : 'caracteres'}.`;
  if (count >= max * COUNTER_WARNING) return `Restam ${max - count} ${max - count === 1 ? 'caractere' : 'caracteres'}.`;
  return '';
};

/** Label, hint, counter and error around any control: `<Field label="Título">{(control) => <TextInput {...control} />}</Field>`. */
export function Field({ label, hint, error, counter, suffix, loading = false, id, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const over = counter !== undefined && counter.count > counter.max;
  const hintId = `${controlId}-hint`;
  const counterId = `${controlId}-counter`;
  const errorId = `${controlId}-error`;
  const suffixId = `${controlId}-suffix`;
  const described = [suffix !== undefined && suffixId, hint !== undefined && hintId, counter !== undefined && counterId, error !== undefined && errorId].filter(Boolean).join(' ');

  const control = children({
    id: controlId,
    'aria-describedby': described === '' ? undefined : described,
    'aria-invalid': error !== undefined || over ? true : undefined,
    'aria-busy': loading ? true : undefined
  });

  return (
    <div className={['ui-field', loading && 'ui-field--loading', className].filter(Boolean).join(' ')}>
      <label className="ui-field__label" htmlFor={controlId}>{label}</label>
      {suffix === undefined ? control : (
        <div className="ui-field__control ui-field__control--suffix" style={{ '--ui-field-suffix-ch': suffix.length } as CSSProperties}>
          {control}
          <span id={suffixId} className="ui-field__suffix">{suffix}</span>
        </div>
      )}
      {(hint !== undefined || counter !== undefined) && (
        <div className="ui-field__meta">
          {hint !== undefined && <p id={hintId} className="ui-field__hint">{hint}</p>}
          {counter !== undefined && (
            <span id={counterId} className={['ui-field__counter', over && 'ui-field__counter--over'].filter(Boolean).join(' ')}>
              {over && <IconSlot><CircleAlert /></IconSlot>}
              {counter.format === 'of' ? `${counter.count} de ${counter.max}` : `${counter.count}/${counter.max}`}
            </span>
          )}
        </div>
      )}
      {counter !== undefined && <span className="ui-field__live" aria-live="polite" aria-atomic="true">{spoken(counter)}</span>}
      {error !== undefined && (
        <p id={errorId} className="ui-field-message">
          <IconSlot><CircleAlert /></IconSlot>
          {error}
        </p>
      )}
    </div>
  );
}
