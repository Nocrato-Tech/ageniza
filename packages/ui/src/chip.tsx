import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> & {
  /** The filter is on: a tint and `aria-pressed`, so the state is also said in words to assistive technology. */
  selected?: boolean;
  /** How many items the filter holds; it is part of the chip's name ("Reels 5"). */
  count?: number;
};

/** A filter that toggles: a capsule with the label, an optional count and the chosen state. For a group with exactly one choice, use `Segmented`. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, count, type = 'button', className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={['ui-chip', selected && 'ui-chip--selected', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
      {count !== undefined && <span className="ui-chip__count">{count}</span>}
    </button>
  );
});
