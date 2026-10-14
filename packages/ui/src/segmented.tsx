import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { IconSlot } from './icon.js';
import { rovingTarget } from './roving.js';

export interface SegmentedOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedProps<T extends string = string> {
  /** Names the group for assistive technology; the options carry their own visible text. */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Freezes the choice while the change it causes is still loading. */
  loading?: boolean;
  className?: string;
}

/** A pair or trio of mutually exclusive views (Grade/Lista): a radio group with a single tab stop and arrow keys. */
export function Segmented<T extends string = string>({ label, value, options, onChange, disabled = false, loading = false, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((option) => !disabled && option.disabled !== true);
  const selected = options.findIndex((option) => option.value === value);
  // The tab stop sits on the chosen option, or on the first usable one when nothing is chosen.
  const stop = selected !== -1 && enabled[selected] ? selected : enabled.indexOf(true);

  // While loading the options keep their focus and ignore the choice: a native `disabled` would drop the keyboard focus.
  const choose = (value: T): void => {
    if (!loading) onChange(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = rovingTarget(event.key, index, enabled, true);
    if (target === null) return;
    event.preventDefault();
    if (loading) return;
    refs.current[target]?.focus();
    onChange(options[target]!.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-busy={loading || undefined}
      aria-disabled={disabled || undefined}
      className={['ui-segmented', className].filter(Boolean).join(' ')}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => { refs.current[index] = node; }}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === stop ? 0 : -1}
          disabled={!enabled[index]}
          aria-disabled={loading || undefined}
          className="ui-segmented__option"
          onClick={() => choose(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.icon !== undefined && <IconSlot>{option.icon}</IconSlot>}
          {option.label}
        </button>
      ))}
    </div>
  );
}
